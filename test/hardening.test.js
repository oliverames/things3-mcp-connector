// Regression tests for the write-safety validator, the commit path, and the read path. Every fetch
// is mocked: nothing here talks to Things Cloud.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ThingsCloudClient,
  ThingsDatabase,
  validateChangeMap,
  repeatRuleProblems,
  generateUUID,
  crc32,
  noteObject,
  buildTaskCreate,
  buildChecklistCreate,
  dateToTimestamp,
  localDate,
  addDays,
} from "../src/things-client.js";

const TZ = "America/New_York";
const today = () => dateToTimestamp(localDate(TZ));
const day = (n) => dateToTimestamp(addDays(localDate(TZ), n));
const refused = (body, db, pattern) => assert.throws(() => validateChangeMap(body, db), pattern);

// --- fixtures -----------------------------------------------------------------------------------

const todo = (id, p = {}) => ({ [id]: { t: 0, e: "Task6", p: { tt: "t", tp: 0, ss: 0, st: 1, tr: false, ...p } } });
const project = (id, p = {}) => todo(id, { tp: 1, ...p });
const heading = (id, projectId, p = {}) => todo(id, { tp: 2, pr: [projectId], ...p });
const area = (id) => ({ [id]: { t: 0, e: "Area3", p: { tt: "area", ix: 0 } } });
const tag = (id) => ({ [id]: { t: 0, e: "Tag4", p: { tt: "tag", ix: 0 } } });
const checklist = (id, taskId) => ({ [id]: { t: 0, e: "ChecklistItem3", p: { tt: "step", ts: [taskId], ss: 0 } } });

function dbOf(...maps) {
  const db = new ThingsDatabase(TZ);
  for (const m of maps) db.applyChangeMap(m);
  db.latestServerIndex = maps.length;
  return db;
}

// A mocked Things Cloud that serves `items` as its history. By default a commit succeeds and is
// appended to the history; `onCommit(n, body)` can return a Response or throw instead.
function cloud(items = [], { onCommit } = {}) {
  const history = [...items];
  const commits = [];
  const calls = [];
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
  const fetchImpl = async (url, init = {}) => {
    url = String(url);
    calls.push({ url, method: init.method });
    if (url.includes("/commit")) {
      const body = JSON.parse(init.body);
      commits.push({ url, body });
      const custom = onCommit ? await onCommit(commits.length, body, history) : undefined;
      if (custom) return custom;
      history.push(body);
      return json({ "server-head-index": history.length });
    }
    if (url.endsWith("/history/KEY")) return json({ "latest-server-index": history.length, "latest-schema-version": 301 });
    if (url.includes("/items")) {
      const start = Number(new URL(url).searchParams.get("start-index"));
      return json({ schema: 301, "current-item-index": history.length, items: history.slice(start) });
    }
    throw new Error(`unexpected ${url}`);
  };
  const client = new ThingsCloudClient({ email: "a@b.c", password: "pw", historyKey: "KEY", timeZone: TZ, fetchImpl });
  return { client, commits, calls, history };
}

// --- "no date" is null, never 0 -------------------------------------------------------------------

test("a date or reminder of 0 is refused: no date must be null", () => {
  const id = generateUUID();
  for (const key of ["sr", "tir", "dd", "sp", "icsd", "ato"]) {
    refused({ [id]: { t: 1, e: "Task6", p: { [key]: 0 } } }, null, new RegExp(`${key} is 0`));
    assert.doesNotThrow(() => validateChangeMap({ [id]: { t: 1, e: "Task6", p: { [key]: null } } }));
  }
});

// --- entity names, keys, tombstones -----------------------------------------------------------------

test("unknown entities, unknown keys, dropped undefined values, and partial creates are refused", () => {
  const id = generateUUID();
  refused({ [id]: { t: 1, e: "Task9", p: {} } }, null, /Task9/);
  refused({ [id]: { t: 1, e: "Settings5", p: {} } }, null, /Settings5/);
  refused({ [id]: { t: 1, e: "Task6", p: { title: "x" } } }, null, /unknown Task6 key "title"/);
  refused({ [id]: { t: 1, e: "Task6", p: { tt: undefined } } }, null, /undefined/);
  refused({ [id]: { t: 2, e: "Task6", p: { tt: "x" } } }, null, /delete must carry an empty p/);
  const create = buildTaskCreate({ title: "x", timeZone: TZ });
  assert.doesNotThrow(() => validateChangeMap({ [id]: create }));
  delete create.p.xx;
  refused({ [id]: create }, null, /create is missing xx/);
});

// --- notes ----------------------------------------------------------------------------------------

test("a note must be a full text object whose ch is the CRC-32 of the UTF-8 text", () => {
  const id = generateUUID();
  const withNote = (nt) => ({ [id]: { t: 1, e: "Task6", p: { nt } } });
  assert.doesNotThrow(() => validateChangeMap(withNote(noteObject("héllo ✓"))));
  assert.doesNotThrow(() => validateChangeMap(withNote(noteObject(""))));
  refused(withNote({ ...noteObject("abc"), ch: crc32("abd") }), null, /not the CRC-32/);
  refused(withNote({ _t: "tx", t: 2, ps: [] }), null, /nt must be exactly/);
  refused(withNote({ ...noteObject("abc"), t: 2 }), null, /nt\.t must be 1/);
  refused(withNote({ ...noteObject("abc"), _t: "xx" }), null, /nt\._t must be "tx"/);
  refused(withNote({ ...noteObject("abc"), v: 5 }), null, /nt\.v must be a string/);
  refused(withNote({ ...noteObject("abc"), extra: 1 }), null, /nt must be exactly/);
});

// --- repeat rules ---------------------------------------------------------------------------------

const START = 1794182400; // 2026-11-09 midnight UTC
const rrOf = (o) => ({ fu: 16, fa: 1, of: [{ dy: 0 }], tp: 0, ia: START, sr: START, rc: 0, ts: 0, rrv: 4, ed: 64092211200, ...o });
const noEd = (o) => {
  const r = rrOf(o);
  delete r.ed;
  return r;
};

test("repeat rules: every shape Things 3.24.2 wrote is accepted", () => {
  const samples = [
    rrOf({}),
    rrOf({ fa: 3 }),
    rrOf({ fu: 256, of: [{ wd: 1 }] }),
    rrOf({ fu: 256, fa: 2, of: [{ wd: 1 }, { wd: 4 }] }),
    rrOf({ fu: 256, of: [1, 2, 3, 4, 5].map((wd) => ({ wd })) }),
    rrOf({ fu: 8, of: [{ dy: 14 }] }),
    rrOf({ fu: 8, of: [{ dy: 0 }, { dy: 14 }] }),
    rrOf({ fu: 8, of: [{ wdo: 2, wd: 2 }] }),
    rrOf({ fu: 8, of: [{ wdo: -1, wd: 5 }] }),
    rrOf({ fu: 8, of: [{ dy: -1 }] }),
    rrOf({ fu: 4, of: [{ dy: 19, mo: 10 }] }),
    rrOf({ fu: 4, of: [{ wdo: 4, mo: 10, wd: 4 }] }),
    rrOf({ fu: 16, fa: 4, of: [], tp: 1, ia: 0 }),
    noEd({ rc: 5 }),
    rrOf({ ed: 1798675200 }),
  ];
  for (const rr of samples) assert.deepEqual(repeatRuleProblems(rr), [], JSON.stringify(rr));
});

test("repeat rules: every malformed shape is rejected", () => {
  const daily = rrOf({});
  const weekly = rrOf({ fu: 256, of: [{ wd: 1 }] });
  const monthly = rrOf({ fu: 8, of: [{ dy: 14 }] });
  const monthlyNth = rrOf({ fu: 8, of: [{ wdo: 2, wd: 2 }] });
  const yearly = rrOf({ fu: 4, of: [{ dy: 19, mo: 10 }] });
  const after = rrOf({ fu: 16, fa: 4, of: [], tp: 1, ia: 0 });
  const counted = noEd({ rc: 5 });
  const m = (base, change) => {
    const o = structuredClone(base);
    change(o);
    return o;
  };
  const bad = {
    "not an object": [],
    "extra key": m(daily, (o) => (o.zz = 1)),
    "missing fu": m(daily, (o) => delete o.fu),
    "missing rrv": m(daily, (o) => delete o.rrv),
    "fu 1": m(daily, (o) => (o.fu = 1)),
    "fu 32": m(daily, (o) => (o.fu = 32)),
    "fa 0": m(daily, (o) => (o.fa = 0)),
    "fa 1000": m(daily, (o) => (o.fa = 1000)),
    "fa fractional": m(daily, (o) => (o.fa = 1.5)),
    "fa string": m(daily, (o) => (o.fa = "1")),
    "tp 2": m(daily, (o) => (o.tp = 2)),
    "rrv 3": m(daily, (o) => (o.rrv = 3)),
    "rrv 5": m(daily, (o) => (o.rrv = 5)),
    "ts 1": m(daily, (o) => (o.ts = 1)),
    "ia not midnight": m(daily, (o) => (o.ia = START + 5)),
    "sr not midnight": m(daily, (o) => (o.sr = START + 5)),
    "ia milliseconds": m(daily, (o) => (o.ia = START * 1000)),
    "ia zero for fixed": m(daily, (o) => (o.ia = 0)),
    "sr null": m(daily, (o) => (o.sr = null)),
    "after completion with ia": m(after, (o) => (o.ia = START)),
    "after completion with offsets": m(after, (o) => (o.of = [{ dy: 0 }])),
    "rc negative": m(daily, (o) => (o.rc = -1)),
    "rc fractional": m(daily, (o) => (o.rc = 1.5)),
    "rc positive with ed": m(counted, (o) => (o.ed = 64092211200)),
    "rc zero without ed": m(daily, (o) => delete o.ed),
    "ed not midnight": m(daily, (o) => (o.ed = 1798675201)),
    "ed past the far future": m(daily, (o) => (o.ed = 64092211200 + 86400)),
    "ed negative": m(daily, (o) => (o.ed = -86400)),
    "fixed rule with empty offsets": m(daily, (o) => (o.of = [])),
    "weekly with empty offsets": m(weekly, (o) => (o.of = [])),
    "of not an array": m(daily, (o) => (o.of = "x")),
    "daily dy 1": m(daily, (o) => (o.of = [{ dy: 1 }])),
    "daily two entries": m(daily, (o) => (o.of = [{ dy: 0 }, { dy: 0 }])),
    "daily with weekday": m(daily, (o) => (o.of = [{ wd: 1 }])),
    "weekly wd 7": m(weekly, (o) => (o.of = [{ wd: 7 }])),
    "weekly wd -1": m(weekly, (o) => (o.of = [{ wd: -1 }])),
    "weekly duplicate": m(weekly, (o) => (o.of = [{ wd: 1 }, { wd: 1 }])),
    "weekly with dy": m(weekly, (o) => (o.of = [{ dy: 1 }])),
    "weekly with wdo": m(weekly, (o) => (o.of = [{ wdo: 1, wd: 1 }])),
    "monthly dy 31": m(monthly, (o) => (o.of = [{ dy: 31 }])),
    "monthly dy -2": m(monthly, (o) => (o.of = [{ dy: -2 }])),
    "monthly duplicate": m(monthly, (o) => (o.of = [{ dy: 3 }, { dy: 3 }])),
    "monthly mixed dy and wdo": m(monthly, (o) => (o.of = [{ dy: 3 }, { wdo: 1, wd: 1 }])),
    "monthly two wdo": m(monthlyNth, (o) => (o.of = [{ wdo: 1, wd: 1 }, { wdo: 2, wd: 1 }])),
    "monthly wdo 0": m(monthlyNth, (o) => (o.of = [{ wdo: 0, wd: 2 }])),
    "monthly wdo 6": m(monthlyNth, (o) => (o.of = [{ wdo: 6, wd: 2 }])),
    "monthly wdo -2": m(monthlyNth, (o) => (o.of = [{ wdo: -2, wd: 2 }])),
    "monthly wd 7": m(monthlyNth, (o) => (o.of = [{ wdo: 1, wd: 7 }])),
    "monthly with mo": m(monthly, (o) => (o.of = [{ dy: 3, mo: 1 }])),
    "entry with extra key": m(monthly, (o) => (o.of = [{ dy: 3, x: 1 }])),
    "yearly two entries": m(yearly, (o) => (o.of = [{ dy: 19, mo: 10 }, { dy: 1, mo: 2 }])),
    "yearly mo 12": m(yearly, (o) => (o.of = [{ dy: 19, mo: 12 }])),
    "yearly mo -1": m(yearly, (o) => (o.of = [{ dy: 19, mo: -1 }])),
    "yearly dy without mo": m(yearly, (o) => (o.of = [{ dy: 19 }])),
    "yearly dy 31": m(yearly, (o) => (o.of = [{ dy: 31, mo: 10 }])),
    "yearly wdo without mo": m(yearly, (o) => (o.of = [{ wdo: 1, wd: 1 }])),
    "yearly wdo 6": m(yearly, (o) => (o.of = [{ wdo: 6, mo: 10, wd: 1 }])),
  };
  assert.ok(Object.keys(bad).length >= 56); // the Swift suite's reject list, plus a few
  for (const [name, rr] of Object.entries(bad)) assert.notEqual(repeatRuleProblems(rr).length, 0, `${name} should be rejected`);
});

test("a malformed rr in a commit is refused, a verified one is accepted", () => {
  const id = generateUUID();
  const change = (rr) => ({ [id]: { t: 1, e: "Task6", p: { rr } } });
  assert.doesNotThrow(() => validateChangeMap(change(rrOf({}))));
  refused(change(rrOf({ fu: 7 })), null, /rr fu must be/);
});

// --- checklist items ------------------------------------------------------------------------------

test("checklist items must match the Things 3.24.2 shape and point at a live to-do", () => {
  const t = generateUUID();
  const db = dbOf(todo(t));
  const create = (over = {}) => {
    const c = buildChecklistCreate({ title: "step", task: t, now: 1794000000.5 });
    Object.assign(c.p, over);
    return { [generateUUID()]: c };
  };
  assert.doesNotThrow(() => validateChangeMap(create(), db));
  // Things writes a negative sort index too.
  assert.doesNotThrow(() => validateChangeMap(create({ ix: -518 }), db));
  refused(create({ ts: [t, generateUUID()] }), db, /exactly one parent/);
  refused(create({ ts: [] }), db, /exactly one parent/);
  refused(create({ ss: 1 }), db, /ss must be 0, 2, or 3/);
  refused(create({ ss: 3, sp: null }), db, /sp must be null exactly when ss is 0/);
  refused(create({ ss: 0, sp: 1794000000 }), db, /sp must be null exactly when ss is 0/);
  refused(create({ xx: {} }), db, /xx must be/);
  refused(create({ ix: "0" }), db, /ix must be a finite number/);
  refused(create({ tt: undefined }), db, /undefined/);
  refused(create({ ts: [generateUUID()] }), db, /existing, untrashed to-do/);
  const project1 = generateUUID();
  refused(create({ ts: [project1] }), dbOf(todo(t), project(project1)), /existing, untrashed to-do/);
  const trashed = generateUUID();
  refused(create({ ts: [trashed] }), dbOf(todo(trashed, { tr: true })), /existing, untrashed to-do/);
  // A to-do created in the same commit is a valid parent.
  const newTask = generateUUID();
  const c = buildChecklistCreate({ title: "s", task: newTask, now: 1794000000 });
  assert.doesNotThrow(() => validateChangeMap({ [newTask]: buildTaskCreate({ title: "x", timeZone: TZ }), [generateUUID()]: c }, db));
});

// --- references -----------------------------------------------------------------------------------

test("references must point at live entities of the right type", () => {
  const [p, h, a, g, t, trashedProject, template] = Array.from({ length: 7 }, generateUUID);
  const tpl = rrOf({});
  const db = dbOf(project(p), heading(h, p), area(a), tag(g), todo(t), project(trashedProject, { tr: true }), todo(template, { rr: tpl, st: 2 }));
  const upd = (id, props) => ({ [id]: { t: 1, e: "Task6", p: props } });
  const ghost = generateUUID();

  assert.doesNotThrow(() => validateChangeMap(upd(t, { pr: [p], tg: [g] }), db));
  assert.doesNotThrow(() => validateChangeMap(upd(t, { agr: [h] }), db));
  assert.doesNotThrow(() => validateChangeMap(upd(t, { ar: [a] }), db));
  refused(upd(t, { pr: [t] }), db, /pr reference .* not an existing, untrashed project/); // to-do, not project
  refused(upd(t, { pr: [h] }), db, /pr reference/); // heading, not project
  refused(upd(t, { pr: [ghost] }), db, /pr reference/); // valid id that does not exist
  refused(upd(t, { pr: [trashedProject] }), db, /pr reference/);
  refused(upd(t, { agr: [p] }), db, /agr reference/);
  refused(upd(t, { agr: [ghost] }), db, /agr reference/);
  refused(upd(t, { ar: [p] }), db, /ar reference/);
  refused(upd(t, { ar: [ghost] }), db, /ar reference/);
  refused(upd(t, { tg: [ghost] }), db, /tg reference/);
  refused(upd(t, { tg: [a] }), db, /tg reference/);
  refused(upd(t, { rt: [t] }), db, /rt reference/);
  refused(upd(t, { pr: [p, trashedProject] }), db, /at most one id/);
  // A reference to something deleted in the same commit is dangling.
  refused({ ...upd(t, { pr: [p] }), [p]: { t: 2, e: "Task6", p: {} } }, db, /project .* still references deleted item|pr reference/);
  const parent = generateUUID();
  refused({ [parent]: { t: 1, e: "Tag4", p: { pn: [parent] } }, [g]: { t: 1, e: "Tag4", p: { pn: [g] } } }, dbOf(tag(g), tag(parent)), /existing tag other than itself/);
});

test("container rules: one parent, and a heading must belong to the project", () => {
  const [p1, p2, h1, a, t] = Array.from({ length: 5 }, generateUUID);
  const db = dbOf(project(p1), project(p2), heading(h1, p1), area(a), todo(t));
  const upd = (props) => ({ [t]: { t: 1, e: "Task6", p: props } });
  refused(upd({ pr: [p1], ar: [a] }), db, /both an area and a project/);
  refused(upd({ agr: [h1], ar: [a] }), db, /both an area and a project/);
  refused(upd({ pr: [p2], agr: [h1] }), db, /belongs to project .*, not/);
  assert.doesNotThrow(() => validateChangeMap(upd({ pr: [p1], agr: [h1] }), db));
  assert.doesNotThrow(() => validateChangeMap(upd({ pr: [], agr: [h1] }), db));
  const orphanHeading = generateUUID();
  refused(
    { [t]: { t: 1, e: "Task6", p: { agr: [orphanHeading] } } },
    dbOf(todo(t), todo(orphanHeading, { tp: 2 })),
    /does not belong to a project/
  );
  // Headings: exactly one project, nothing else. Projects: no project or heading.
  const newHeading = generateUUID();
  const h = buildTaskCreate({ title: "h", type: 2, when: "anytime", project: p1, timeZone: TZ });
  assert.doesNotThrow(() => validateChangeMap({ [newHeading]: h }, db));
  h.p.pr = [];
  refused({ [newHeading]: h }, db, /heading belongs to exactly one project/);
  h.p.pr = [p1];
  h.p.ar = [a];
  refused({ [newHeading]: h }, db, /heading belongs to exactly one project/);
  refused({ [p2]: { t: 1, e: "Task6", p: { pr: [p1] } } }, db, /project cannot be inside a project/);
});

// --- st / sr / ss / sp ----------------------------------------------------------------------------

test("start (st) must agree with the start date (sr)", () => {
  const t = generateUUID();
  const h = generateUUID();
  const p = generateUUID();
  const db = dbOf(todo(t), project(p), heading(h, p));
  const upd = (id, props) => ({ [id]: { t: 1, e: "Task6", p: props } });
  assert.doesNotThrow(() => validateChangeMap(upd(t, { st: 2, sr: day(3), tir: day(3) }), db));
  assert.doesNotThrow(() => validateChangeMap(upd(t, { st: 1, sr: day(0), tir: day(0) }), db));
  assert.doesNotThrow(() => validateChangeMap(upd(t, { st: 1, sr: null, tir: null }), db));
  assert.doesNotThrow(() => validateChangeMap(upd(t, { st: 2, sr: null, tir: null }), db));
  refused(upd(t, { st: 1, sr: day(3), tir: day(3) }), db, /in the future, so st must be 2/);
  refused(upd(t, { st: 0, sr: day(3), tir: day(3) }), db, /in the future, so st must be 2|Inbox/);
  refused(upd(t, { st: 2, sr: day(0), tir: day(0) }), db, /today or past, is inconsistent/);
  refused(upd(t, { st: 2, sr: day(-4), tir: day(-4) }), db, /today or past, is inconsistent/);
  refused(upd(t, { st: 0, sr: day(0), tir: day(0) }), db, /Inbox to-do \(st 0\) cannot have a start date/);
  refused(upd(h, { st: 2 }), db, /heading must have st 1/);
  // Merged state: touching only sr on a someday to-do is judged against its existing st.
  const someday = generateUUID();
  refused(upd(someday, { sr: day(0) }), dbOf(todo(someday, { st: 2 })), /today or past/);
});

test("a to-do in a project, heading, or area cannot be in the Inbox, and a reminder needs a date", () => {
  const [p, a, t, inboxTodo] = Array.from({ length: 4 }, generateUUID);
  const db = dbOf(project(p), area(a), todo(t), todo(inboxTodo, { st: 0 }));
  const upd = (id, props) => ({ [id]: { t: 1, e: "Task6", p: props } });
  refused(upd(t, { st: 0 }), dbOf(project(p), todo(t, { pr: [p] })), /cannot be in the Inbox/);
  refused(upd(inboxTodo, { ar: [a] }), db, /cannot be in the Inbox/);
  assert.doesNotThrow(() => validateChangeMap(upd(inboxTodo, { ar: [a], st: 1 }), db));
  refused(upd(t, { ato: 32400 }), db, /reminder time needs a start date/);
  assert.doesNotThrow(() => validateChangeMap(upd(t, { ato: 32400, st: 1, sr: day(0), tir: day(0) }), db));
  refused(upd(t, { ato: 90000 }), db, /ato must be null or whole seconds/);
});

test("a stop date goes with completed or canceled items only", () => {
  const [open, done] = [generateUUID(), generateUUID()];
  const db = dbOf(todo(open), todo(done, { ss: 3, sp: 1794000000 }));
  const upd = (id, props) => ({ [id]: { t: 1, e: "Task6", p: props } });
  assert.doesNotThrow(() => validateChangeMap(upd(open, { ss: 3, sp: 1794000000 }), db));
  assert.doesNotThrow(() => validateChangeMap(upd(done, { ss: 0, sp: null }), db));
  refused(upd(open, { ss: 3 }), db, /needs a stop date/);
  refused(upd(open, { sp: 1794000000 }), db, /open item cannot have a stop date/);
  refused(upd(done, { ss: 0 }), db, /open item cannot have a stop date/);
});

// --- create / update / delete against what exists -----------------------------------------------------

test("creates never overwrite, updates and deletes need an existing item of the same kind", () => {
  const [t, a] = [generateUUID(), generateUUID()];
  const db = dbOf(todo(t), area(a));
  refused({ [t]: buildTaskCreate({ title: "x", timeZone: TZ }) }, db, /overwrite an existing item/);
  refused({ [generateUUID()]: { t: 1, e: "Task6", p: { tt: "x" } } }, db, /does not exist/);
  refused({ [generateUUID()]: { t: 2, e: "Task6", p: {} } }, db, /does not exist/);
  refused({ [t]: { t: 1, e: "Area3", p: { tt: "x" } } }, db, /does not match the existing/);
  assert.doesNotThrow(() => validateChangeMap({ [t]: { t: 1, e: "Task6", p: { tt: "x" } } }, db));
});

test("deleting an item that others still reference is refused", () => {
  const [p, h, child, g, tagged, tpl, occ, underHeading] = Array.from({ length: 8 }, generateUUID);
  const db = dbOf(
    project(p),
    heading(h, p),
    todo(child, { pr: [p] }),
    tag(g),
    todo(tagged, { tg: [g] }),
    todo(tpl, { rr: rrOf({}), st: 2 }),
    todo(occ, { rt: [tpl] }),
    todo(underHeading, { agr: [h] })
  );
  const del = (id, e = "Task6") => ({ [id]: { t: 2, e, p: {} } });
  refused(del(p), db, /project still references deleted item/);
  refused(del(h), db, /heading still references deleted item/);
  refused(del(g, "Tag4"), db, /tag list still references deleted item/);
  refused(del(tpl), db, /repeat template still references deleted item/);
  // Repointing in the same commit makes it safe.
  assert.doesNotThrow(() => validateChangeMap({ ...del(g, "Tag4"), [tagged]: { t: 1, e: "Task6", p: { tg: [] } } }, db));
});

// --- repeating templates and occurrences -----------------------------------------------------------

test("repeating templates and occurrences cannot be rescheduled or have their rule touched", () => {
  const [tpl, occ] = [generateUUID(), generateUUID()];
  const db = dbOf(todo(tpl, { rr: rrOf({}), st: 2, sr: null, tir: day(2), icsd: day(2), icc: 0 }), todo(occ, { rt: [tpl], sr: day(0), tir: day(0) }));
  const upd = (id, props) => ({ [id]: { t: 1, e: "Task6", p: props } });
  assert.doesNotThrow(() => validateChangeMap(upd(tpl, { tt: "renamed", md: 1794000000.5 }), db));
  for (const props of [{ st: 1, sr: day(0), tir: day(0) }, { sr: day(5) }, { dd: day(5) }, { ss: 3, sp: 1794000000 }, { rr: null }, { rr: rrOf({ fa: 2 }) }, { ato: 3600 }]) {
    refused(upd(tpl, props), db, /would change a repeating template/);
  }
  assert.doesNotThrow(() => validateChangeMap(upd(occ, { ss: 3, sp: 1794000000 }), db));
  for (const props of [{ rr: rrOf({}) }, { rt: [] }, { tp: 1 }]) {
    refused(upd(occ, props), db, /would change a repeating occurrence/);
  }
});

// --- client: container defaults and moves -------------------------------------------------------------

test("a to-do created in a project defaults to Anytime, an unfiled one to the Inbox", async () => {
  const p = generateUUID();
  const { client, commits } = cloud([project(p)]);
  const inProject = await client.createTodo({ title: "in project", project: p });
  const loose = await client.createTodo({ title: "loose" });
  assert.equal(commits[0].body[inProject.id].p.st, 1);
  assert.deepEqual(commits[0].body[inProject.id].p.pr, [p]);
  assert.equal(commits[1].body[loose.id].p.st, 0);
  await assert.rejects(client.createTodo({ title: "x", project: p, when: "inbox" }), /cannot be in the Inbox/);
  assert.equal(commits.length, 2);
});

test("moving an Inbox to-do into a project takes it out of the Inbox", async () => {
  const [p, t] = [generateUUID(), generateUUID()];
  const { client, commits } = cloud([project(p), todo(t, { st: 0 })]);
  await client.moveTodo(t, { project: p });
  assert.equal(commits[0].body[t].p.st, 1);
});

// --- client: deletes cascade, imports leave the cache clean ---------------------------------------------

test("deleting a tag strips it from the items that carry it in the same commit", async () => {
  const [g, t, a] = [generateUUID(), generateUUID(), generateUUID()];
  const { client, commits } = cloud([tag(g), todo(t, { tg: [g] }), { [a]: { t: 0, e: "Area3", p: { tt: "a", tg: [g], ix: 0 } } }]);
  await client.deleteTag(g);
  const body = commits[0].body;
  assert.equal(body[g].t, 2);
  assert.deepEqual(body[t].p.tg, []);
  assert.deepEqual(body[a].p.tg, []);
});

test("emptying the trash also removes checklist items and headings, and refuses to orphan live children", async () => {
  const [p, h, t, c, live] = Array.from({ length: 5 }, generateUUID);
  const { client, commits } = cloud([project(p, { tr: true }), heading(h, p), todo(t, { pr: [p], tr: true }), checklist(c, t)]);
  await client.emptyTrash();
  assert.deepEqual(Object.keys(commits[0].body).sort(), [p, h, t, c].sort());
  assert.ok(Object.values(commits[0].body).every((ch) => ch.t === 2));

  const second = cloud([project(p, { tr: true }), todo(live, { pr: [p] })]);
  await assert.rejects(second.client.emptyTrash(), /still references deleted item/);
  assert.equal(second.commits.length, 0);
  await assert.rejects(second.client.deleteEntity(p), /still references deleted item/);
  assert.equal(second.commits.length, 0);
});

test("a refused or failed import leaves the cached database untouched", async () => {
  const { client, commits } = cloud([], { onCommit: () => new Response("bad", { status: 400 }) });
  await client.syncDatabase();
  await assert.rejects(client.importJson([{ type: "project", attributes: { title: "P", items: [{ type: "to-do", attributes: { title: "T" } }] } }]), /nothing was written/);
  assert.equal(commits.length, 1);
  assert.equal(client._db.tasks.size, 0);
  await assert.rejects(client.importJson([{ type: "to-do", attributes: { title: "x", when: "someday-ish" } }]), /Invalid "when"/);
  assert.equal(client._db.tasks.size, 0);
});

test("import_json refuses entries it cannot write instead of dropping them", async () => {
  const { client, commits } = cloud();
  await assert.rejects(client.importJson([{ type: "heading", attributes: { title: "h" } }]), /Unsupported top-level type/);
  await assert.rejects(client.importJson([{ type: "project", attributes: { title: "p", items: [{ type: "checklist", attributes: {} }] } }]), /Unsupported project child type/);
  await assert.rejects(client.importJson(["nope"]), /must be an object/);
  assert.equal(commits.length, 0);
});

test("an import with a checklist item that has no title is refused", async () => {
  const { client, commits } = cloud();
  await assert.rejects(client.importJson([{ type: "to-do", attributes: { title: "x", checklist: [{ notitle: true }] } }]), /tt is undefined/);
  assert.equal(commits.length, 0);
});

// --- client: batch tools ---------------------------------------------------------------------------------

test("batch tools are one atomic commit with per-item results, and name every bad id", async () => {
  const [a, b, p] = Array.from({ length: 3 }, generateUUID);
  const { client, commits } = cloud([todo(a, { tt: "A" }), todo(b, { tt: "B" }), project(p, { tt: "P" })]);
  const missing1 = generateUUID();
  const missing2 = generateUUID();
  await assert.rejects(client.batchUpdateTodos([a, missing1, b, missing2], "complete"), (err) => err.message.includes(missing1) && err.message.includes(missing2) && /Nothing was written/.test(err.message));
  assert.equal(commits.length, 0);

  const result = await client.batchUpdateTodos([a, b, a], "complete");
  assert.equal(commits.length, 1);
  assert.equal(result.count, 2);
  assert.deepEqual(result.items.map((i) => [i.id, i.title, i.result]), [[a, "A", "updated"], [b, "B", "updated"]]);
  assert.deepEqual(Object.keys(commits[0].body).sort(), [a, b].sort());

  await assert.rejects(client.batchUpdateTodos([a], "reschedule"), /needs "when"/);
  await assert.rejects(client.batchUpdateTodos([a], "set_dates"), /needs deadline/);
  await assert.rejects(client.batchUpdateProjects([p], "set_area"), /needs "area"/);
  await assert.rejects(client.batchUpdateProjects([a], "complete"), /Project not found: /);
  assert.equal(commits.length, 1);
});

test("a batch that would write something unsafe writes nothing", async () => {
  const [a, tpl] = [generateUUID(), generateUUID()];
  const { client, commits } = cloud([todo(a), todo(tpl, { rr: rrOf({}), st: 2 })]);
  await assert.rejects(client.batchUpdateTodos([a, tpl], "complete"), /would change a repeating template/);
  await assert.rejects(client.batchUpdateTodos([a], "reschedule", { when: "someday" }).then(() => client.updateTodo(a, { reminderTime: "00:00" })), /ato is 0/);
  assert.equal(commits.length, 1); // only the valid reschedule above
});

// --- commit path ------------------------------------------------------------------------------------------

test("a 409 is retried with the real head and the same ids", async () => {
  const { client, commits } = cloud([], {
    onCommit: (n, body, history) => {
      if (n === 1) {
        history.push({ [generateUUID()]: { t: 0, e: "Tag4", p: { tt: "from another device", ix: 0 } } }); // someone else committed
        return new Response("conflict", { status: 409 });
      }
    },
  });
  await client.syncDatabase();
  const created = await client.createTodo({ title: "once" });
  assert.equal(commits.length, 2);
  assert.match(commits[0].url, /ancestor-index=0&/);
  assert.match(commits[1].url, /ancestor-index=1&/);
  assert.deepEqual(commits[0].body, commits[1].body);
  assert.deepEqual(Object.keys(commits[1].body), [created.id]);
});

test("a persistent 409 or 412 fails loudly after bounded retries and drops the cache", async () => {
  const { client, commits } = cloud([], { onCommit: () => new Response("stale", { status: 412 }) });
  await assert.rejects(client.createTodo({ title: "x" }), /Commit failed \(412\)/);
  assert.equal(commits.length, 3);
  assert.equal(client._dbCheckedAt, 0);
});

test("a 4xx rejection says nothing was written and is not retried", async () => {
  const { client, commits } = cloud([], { onCommit: () => new Response("nope", { status: 400 }) });
  await assert.rejects(client.createTodo({ title: "x" }), /nothing was written/);
  assert.equal(commits.length, 1);
});

test("a 5xx after the commit landed is recognised and not sent again, so a retry cannot duplicate a create", async () => {
  const { client, commits, history } = cloud([], {
    onCommit: (n, body, h) => {
      h.push(body); // the server applied it, then failed to answer
      return new Response("upstream error", { status: 502 });
    },
  });
  const created = await client.createTodo({ title: "once" });
  assert.equal(commits.length, 1);
  assert.equal(history.length, 1);
  assert.ok(created.id);
});

test("a 5xx that did not land is resent once with the same ids", async () => {
  const { client, commits, history } = cloud([], { onCommit: (n) => (n === 1 ? new Response("boom", { status: 503 }) : undefined) });
  await client.createTodo({ title: "once" });
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[0].body, commits[1].body);
  assert.equal(history.length, 1);
});

test("a dropped connection with an unreadable history says the outcome is unknown and never resends", async () => {
  let calls = 0;
  const base = cloud();
  const fetchImpl = async (url, init) => {
    if (String(url).includes("/commit")) {
      calls++;
      throw new TypeError("fetch failed");
    }
    if (calls > 0) return new Response("down", { status: 500 }); // history unreadable after the failure
    return base.client.fetch(url, init);
  };
  const client = new ThingsCloudClient({ email: "a@b.c", password: "pw", historyKey: "KEY", timeZone: TZ, fetchImpl });
  await client.syncDatabase();
  await assert.rejects(client.createTodo({ title: "x" }), /MAY have been applied/);
  assert.equal(calls, 1);
});

test("a stale-cache update is re-validated against the fresh head before a retry", async () => {
  const [p, t] = [generateUUID(), generateUUID()];
  const { client, commits } = cloud([project(p), todo(t)], {
    onCommit: (n, body, history) => {
      if (n === 1) {
        history.push({ [p]: { t: 2, e: "Task6", p: {} } }); // another device deleted the project
        return new Response("conflict", { status: 409 });
      }
    },
  });
  await assert.rejects(client.updateTodo(t, { project: p }), /pr reference/);
  assert.equal(commits.length, 1);
});

// --- read path --------------------------------------------------------------------------------------------

test("history pagination advances by items received and an empty page before the head fails closed", async () => {
  const all = [1, 2, 3, 4, 5].map((n) => todo(generateUUID(), { tt: `task ${n}` }));
  const json = (data) => new Response(JSON.stringify(data));
  const mk = (limit, items = all) => async (url) => {
    if (String(url).endsWith("/history/KEY")) return json({ "latest-server-index": 5 });
    const start = Number(new URL(url).searchParams.get("start-index"));
    return json({ "current-item-index": 5, items: items.slice(start, start + limit) });
  };
  const ok = new ThingsCloudClient({ email: "a@b.c", password: "pw", historyKey: "KEY", fetchImpl: mk(2) });
  assert.equal((await ok.syncDatabase()).tasks.size, 5);

  // The server stops early: three items, then empty pages although the head is 5.
  const short = new ThingsCloudClient({ email: "a@b.c", password: "pw", historyKey: "KEY", fetchImpl: mk(3, all.slice(0, 3)) });
  await assert.rejects(short.syncDatabase(), /was empty although the server head is 5/);
  assert.equal(short._db, null);
});

test("a malformed history page or head is an error, never an empty database", async () => {
  const json = (data) => new Response(JSON.stringify(data));
  const client = (head, page) =>
    new ThingsCloudClient({
      email: "a@b.c",
      password: "pw",
      historyKey: "KEY",
      fetchImpl: async (url) => (String(url).endsWith("/history/KEY") ? json(head) : json(page)),
    });
  await assert.rejects(client({}, {}).syncDatabase(), /no valid latest-server-index/);
  await assert.rejects(client({ "latest-server-index": "5" }, {}).syncDatabase(), /no valid latest-server-index/);
  await assert.rejects(client({ "latest-server-index": 2 }, { items: "none" }).syncDatabase(), /malformed/);
  await assert.rejects(client({ "latest-server-index": 2 }, {}).syncDatabase(), /malformed/);
  await assert.rejects(client({ "latest-server-index": 2 }, { items: [null, null] }).syncDatabase(), /malformed/);
});

test("a pull that fails part-way leaves the cached database as it was", async () => {
  const first = todo(generateUUID(), { tt: "first" });
  const second = todo(generateUUID(), { tt: "second" });
  let head = 1;
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/history/KEY")) return new Response(JSON.stringify({ "latest-server-index": head }));
    const start = Number(new URL(url).searchParams.get("start-index"));
    // The first item is good and the second has an undecodable payload, so applying fails half-way.
    if (start === 0) return new Response(JSON.stringify({ items: [first] }));
    return new Response(JSON.stringify({ items: [second, { [generateUUID()]: { t: 0, e: "Task6", p: "garbage" } }] }));
  };
  const client = new ThingsCloudClient({ email: "a@b.c", password: "pw", historyKey: "KEY", fetchImpl });
  await client.syncDatabase();
  head = 3;
  client.invalidateCache();
  await assert.rejects(client.syncDatabase());
  assert.equal(client._db.tasks.size, 1); // "second" was not half-applied
  assert.equal(client._db.latestServerIndex, 1);
});

test("a head that drops to 0 after a successful sync does not wipe the cache", async () => {
  let head = 1;
  const item = todo(generateUUID());
  const fetchImpl = async (url) =>
    String(url).endsWith("/history/KEY") ? new Response(JSON.stringify({ "latest-server-index": head })) : new Response(JSON.stringify({ items: [item] }));
  const client = new ThingsCloudClient({ email: "a@b.c", password: "pw", historyKey: "KEY", fetchImpl });
  await client.syncDatabase();
  head = 0;
  client.invalidateCache();
  await assert.rejects(client.syncDatabase(), /refusing to discard/);
  assert.equal(client._db.tasks.size, 1);
});

test("Task7 items from Things 3.24 decode, and changes to them validate", async () => {
  const [t, p] = [generateUUID(), generateUUID()];
  const seven = (id, props) => ({ [id]: { t: 0, e: "Task7", p: { tt: "t", tp: 0, ss: 0, st: 1, tr: false, ...props } } });
  const { client, commits } = cloud([{ [p]: { t: 0, e: "Task7", p: { tt: "P", tp: 1, ss: 0, st: 1, tr: false } } }, seven(t, { tt: "seven", st: 0 })]);
  const db = await client.syncDatabase();
  assert.equal(db.getTask(t).title, "seven");
  assert.equal(db.getInbox().length, 1);
  assert.equal(db.entityOf(t), "Task6");
  await client.updateTodo(t, { title: "renamed" });
  assert.equal(commits[0].body[t].p.tt, "renamed");
  // A Task7 template is still recognised as a template.
  const tpl = generateUUID();
  const withTemplate = cloud([seven(tpl, { rr: rrOf({}), st: 2 })]);
  await assert.rejects(withTemplate.client.updateTodo(tpl, { when: "today" }), /would change a repeating template/);
});
