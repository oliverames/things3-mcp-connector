// Regression tests for the write-safety validator, the commit path, and the read path. Every fetch
// is mocked: nothing here talks to Things Cloud.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loginPage, errorPage, withSecurityHeaders } from "../src/pages.js";
import {
  describeRepeatRule,
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
  buildRepeatingTaskCreate,
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

test("emptying the trash removes checklist items, headings, and the contents of a trashed project; a live project keeps its children", async () => {
  const [p, h, t, c, live] = Array.from({ length: 5 }, generateUUID);
  const { client, commits } = cloud([project(p, { tr: true }), heading(h, p), todo(t, { pr: [p], tr: true }), checklist(c, t)]);
  await client.emptyTrash();
  assert.deepEqual(Object.keys(commits[0].body).sort(), [p, h, t, c].sort());
  assert.ok(Object.values(commits[0].body).every((ch) => ch.t === 2));

  // Things leaves tr false on the to-dos of a trashed project; they go with it, under a heading too.
  const [under, c2] = [generateUUID(), generateUUID()];
  const second = cloud([project(p, { tr: true }), heading(h, p), todo(live, { pr: [p] }), todo(under, { agr: [h] }), checklist(c2, under)]);
  const result = await second.client.emptyTrash();
  assert.deepEqual(Object.keys(second.commits[0].body).sort(), [p, h, live, under, c2].sort());
  assert.ok(Object.values(second.commits[0].body).every((ch) => ch.t === 2));
  assert.deepEqual(result, { purgedCount: 4, trashedCount: 1, containedCount: 3 });

  // A project that is not in the Trash is never purged out from under its to-dos.
  const third = cloud([project(p), todo(live, { pr: [p] })]);
  await assert.rejects(third.client.deleteEntity(p, "project"), /still references deleted item/);
  assert.equal(third.commits.length, 0);
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
  await assert.rejects(client.batchUpdateTodos([a], "reschedule", { when: "someday" }).then(() => client.updateTodo(a, { reminderTime: "00:00" })), /00:00 cannot be stored/);
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

// --- audit 2026-11-09: destructive tools, kinds, cycles, recovery --------------------------------------

test("permanent deletes only tombstone the kind of item the tool names", async () => {
  const [t, c, p, h, a, g] = Array.from({ length: 6 }, generateUUID);
  const { client, commits } = cloud([todo(t), checklist(c, t), project(p), heading(h, p), area(a), tag(g)]);
  await assert.rejects(client.deleteChecklistItem(t), /is a to-do, not a checklist item/);
  await assert.rejects(client.deleteTodo(p), /is a project, not a to-do/);
  await assert.rejects(client.deleteTodo(h), /is a heading, not a to-do/);
  await assert.rejects(client.deleteTodo(a), /is an area, not a to-do/);
  await assert.rejects(client.deleteTodo(c), /is a checklist item, not a to-do/);
  await assert.rejects(client.updateHeading(p, { deleted: true }), /is a project, not a heading/);
  await assert.rejects(client.deleteTag(t), /No tag with id/);
  await assert.rejects(client.deleteArea(g), /No area with id/);
  await assert.rejects(client.deleteEntity(t), /needs a kind/);
  assert.equal(commits.length, 0);

  await client.deleteChecklistItem(c);
  assert.deepEqual(commits[0].body, { [c]: { t: 2, e: "ChecklistItem3", p: {} } });
  await client.deleteTodo(t);
  assert.deepEqual(commits[1].body, { [t]: { t: 2, e: "Task6", p: {} } });
});

test("to-do tools refuse project and heading ids, and project tools refuse to-do ids", async () => {
  const [t, p, h] = Array.from({ length: 3 }, generateUUID);
  const { client, commits } = cloud([todo(t), project(p), heading(h, p)]);
  await assert.rejects(client.updateTodo(p, { status: "completed" }), /is a project, not a to-do.*Use the project tools/);
  await assert.rejects(client.updateTodo(h, { status: "completed", trashed: true }), /is a heading, not a to-do/);
  await assert.rejects(client.trashTodo(h), /is a heading, not a to-do/);
  await assert.rejects(client.moveTodo(p, { when: "today" }), /is a project, not a to-do/);
  await assert.rejects(client.updateProject(t, { title: "x" }), /is a to-do, not a project/);
  await assert.rejects(client.batchUpdateTodos([t, p, h], "complete"), (err) => err.message.includes(`${p} (a project)`) && err.message.includes(`${h} (a heading)`) && !err.message.includes(`${t} (`));
  await assert.rejects(client.duplicateTodo(p), /is a project, not a to-do/);
  await assert.rejects(client.addTagsToTask(h, []), /is a heading/);
  assert.equal(commits.length, 0);
  await client.updateProject(p, { title: "renamed" });
  assert.equal(commits[0].body[p].p.tt, "renamed");
});

test("a tag cannot become its own ancestor", async () => {
  const [work, errands, shop] = Array.from({ length: 3 }, generateUUID);
  const named = (id, tt, pn = []) => ({ [id]: { t: 0, e: "Tag4", p: { tt, pn, ix: 0 } } });
  const { client, commits } = cloud([named(work, "Work"), named(errands, "Errands", [work]), named(shop, "Shop", [errands])]);
  await assert.rejects(client.updateTag(work, { parent: "Errands" }), /its own ancestor/);
  await assert.rejects(client.updateTag(work, { parent: shop }), /its own ancestor/);
  await assert.rejects(client.updateTag(work, { parent: work }), /other than itself/);
  assert.equal(commits.length, 0);
  await client.updateTag(shop, { parent: work });
  assert.deepEqual(commits[0].body[shop].p.pn, [work]);
});

test("after a 5xx, another client's edit to the same item is not counted as our commit", async () => {
  const t = generateUUID();
  const { client, commits, history } = cloud([todo(t)], {
    onCommit: (n, body, h) => {
      if (n !== 1) return undefined;
      h.push({ [t]: { t: 1, e: "Task6", p: { tt: "edited on the Mac", md: 1794000000.25 } } });
      return new Response("unavailable", { status: 503 });
    },
  });
  await client.updateTodo(t, { status: "completed" });
  assert.equal(commits.length, 2); // ours had not landed, so it was sent again
  assert.equal(history.at(-1)[t].p.ss, 3);
  assert.equal((await client.syncDatabase()).tasks.get(t).status, 3);
});

// --- audit 2026-11-09: dates, reminders, containers, text ------------------------------------------------

test("a date that is not in the calendar is refused, not rolled forward", async () => {
  assert.throws(() => dateToTimestamp("2027-02-31"), /does not exist/);
  assert.throws(() => dateToTimestamp("2027-13-45"), /does not exist/);
  assert.equal(dateToTimestamp("2028-02-29"), Date.UTC(2028, 1, 29) / 1000);
  const { client, commits } = cloud([]);
  await assert.rejects(client.createTodo({ title: "x", when: "2027-02-31" }), /does not exist/);
  await assert.rejects(client.createTodo({ title: "x", deadline: "2027-04-31" }), /does not exist/);
  assert.equal(commits.length, 0);
});

test("moving a to-do to Someday, Anytime, or the Inbox clears its reminder; a dated move keeps it", async () => {
  const t = generateUUID();
  const { client, commits } = cloud([todo(t, { sr: day(0), tir: day(0), ato: 32400 })]);
  for (const when of ["someday", "anytime", "inbox"]) {
    await client.updateTodo(t, { when });
    const p = commits.at(-1).body[t].p;
    assert.equal(p.ato, null, when);
    assert.equal(p.sr, null, when);
    await client.updateTodo(t, { when: "today", reminderTime: "09:00" });
  }
  await client.moveTodo(t, { when: addDays(localDate(TZ), 3) });
  assert.ok(!("ato" in commits.at(-1).body[t].p));
  await client.batchUpdateTodos([t], "reschedule", { when: "someday" });
  assert.equal(commits.at(-1).body[t].p.ato, null);
  // The state itself is refused whichever key the patch carries.
  const db = dbOf(todo(t, { sr: day(0), tir: day(0), ato: 32400 }));
  refused({ [t]: { t: 1, e: "Task6", p: { st: 2, sr: null, tir: null } } }, db, /reminder time needs a start date/);
});

test("a reminder needs a date: undated lists are refused, no when means today, null clears it", async () => {
  const t = generateUUID();
  const { client, commits } = cloud([todo(t, { sr: day(0), tir: day(0), ato: 32400 })]);
  await assert.rejects(client.createTodo({ title: "x", when: "someday", reminderTime: "09:00" }), /reminder needs a date/);
  await assert.rejects(client.updateTodo(t, { when: "anytime", reminderTime: "09:00" }), /reminder needs a date/);
  await assert.rejects(client.createTodo({ title: "x", when: "today", reminderTime: "00:00" }), /00:00 cannot be stored/);
  assert.equal(commits.length, 0);
  const made = await client.createTodo({ title: "x", reminderTime: "09:00" });
  assert.equal(made.when, "today");
  assert.deepEqual([commits[0].body[made.id].p.st, commits[0].body[made.id].p.sr, commits[0].body[made.id].p.ato], [1, today(), 32400]);
  await client.updateTodo(t, { reminderTime: null, deadline: null });
  const p = commits[1].body[t].p;
  assert.deepEqual([p.ato, p.dd, "sr" in p], [null, null, false]);
});

test("a project made from an Inbox to-do leaves the Inbox, and a project at st 0 is refused", async () => {
  const [t, c] = [generateUUID(), generateUUID()];
  const { client, commits } = cloud([todo(t, { st: 0 }), checklist(c, t)]);
  await client.convertTodoToProject(t);
  const p = commits[0].body[t].p;
  assert.deepEqual([p.tp, p.st, p.sb], [1, 1, 0]);
  const db = dbOf(todo(t, { st: 0 }));
  refused({ [t]: { t: 1, e: "Task6", p: { tp: 1, pr: [], agr: [] } } }, db, /project cannot be in the Inbox/);
});

test("a heading given with a project must belong to it, and the to-do is filed under the heading", async () => {
  const [a, b, ha, hb, other, t] = Array.from({ length: 6 }, generateUUID);
  const { client, commits } = cloud([
    project(a, { tt: "A" }),
    project(b, { tt: "B" }),
    heading(ha, a, { tt: "Backlog" }),
    heading(hb, b, { tt: "Backlog" }),
    heading(other, b, { tt: "Later" }),
    todo(t),
  ]);
  await client.moveTodo(t, { project: a, heading: ha });
  assert.deepEqual([commits[0].body[t].p.agr, commits[0].body[t].p.pr], [[ha], []]);
  await assert.rejects(client.moveTodo(t, { project: a, heading: other }), /belongs to another project/);
  await assert.rejects(client.createTodo({ title: "x", project: "A", heading: "Later" }), /belongs to another project/);
  assert.equal(commits.length, 1);

  // "Backlog" exists in both projects; the project says which one is meant.
  const made = await client.createTodo({ title: "x", project: "A", heading: "backlog" });
  assert.deepEqual([commits[1].body[made.id].p.agr, commits[1].body[made.id].p.pr], [[ha], []]);
  const imported = await client.importJson([{ type: "to-do", attributes: { title: "row", list: "B", heading: "Backlog" } }]);
  assert.deepEqual(commits[2].body[imported.items[0].id].p.agr, [hb]);
  await client.importJson([{ type: "to-do", operation: "update", id: t, attributes: { list: "B", heading: "Later" } }]);
  assert.deepEqual([commits[3].body[t].p.agr, commits[3].body[t].p.pr], [[other], []]);
});

test("a to-do cannot be filed under a heading of a trashed project", async () => {
  const [p, h] = [generateUUID(), generateUUID()];
  const { client, commits } = cloud([project(p, { tr: true }), heading(h, p, { tt: "Old" })]);
  await assert.rejects(client.createTodo({ title: "x", heading: h }), /No heading found/);
  assert.equal(commits.length, 0);
});

test("a lone surrogate is refused in every text field, not only task titles", async () => {
  const bad = "cut \ud83d";
  const [g, a] = [generateUUID(), generateUUID()];
  const { client, commits } = cloud([tag(g), area(a)]);
  await assert.rejects(client.createTodo({ title: "ok", notes: bad }), /nt\.v contains a lone surrogate/);
  await assert.rejects(client.createTodo({ title: "ok", checklist: [bad] }), /tt contains a lone surrogate/);
  await assert.rejects(client.createTag({ title: bad }), /lone surrogate/);
  await assert.rejects(client.updateTag(g, { shortcut: "\ud83d" }), /sh contains a lone surrogate/);
  await assert.rejects(client.createArea({ title: bad }), /lone surrogate/);
  await assert.rejects(client.updateArea(a, { title: bad }), /lone surrogate/);
  assert.equal(commits.length, 0);
  await client.createTodo({ title: "ok", notes: "whole 😀", checklist: ["fine 😀"] });
  assert.equal(commits.length, 1);
});

// --- audit 2026-11-09: read side ------------------------------------------------------------------------

test("Today is what Things shows: arrived start dates at st 1 or 2, due and overdue deadlines, live containers only", () => {
  const [trashedP, doneP, trashedH, liveP] = Array.from({ length: 4 }, generateUUID);
  const named = (tt, p) => todo(generateUUID(), { tt, ...p });
  const db = dbOf(
    project(trashedP, { tr: true }),
    project(doneP, { ss: 3, sp: 1794000000 }),
    project(liveP),
    heading(trashedH, liveP, { tr: true }),
    named("today", { sr: day(0), tir: day(0) }),
    named("scheduled, not yet confirmed", { st: 2, sr: day(0), tir: day(0) }),
    named("scheduled yesterday", { st: 2, sr: day(-1), tir: day(-1) }),
    named("future", { st: 2, sr: day(3), tir: day(3) }),
    named("overdue deadline", { dd: day(-2) }),
    named("someday, due today", { st: 2, dd: day(0) }),
    named("deadline dismissed from Today", { dd: day(-1), dds: day(0) }),
    named("future start, overdue deadline", { st: 2, sr: day(3), dd: day(-1) }),
    named("in trashed project", { sr: day(0), pr: [trashedP] }),
    named("in completed project", { sr: day(0), pr: [doneP] }),
    named("under trashed heading", { sr: day(0), agr: [trashedH] }),
    named("someday", { st: 2 })
  );
  const titles = (list) => list.map((t) => t.title).sort();
  assert.deepEqual(titles(db.getToday()), ["overdue deadline", "scheduled yesterday", "scheduled, not yet confirmed", "someday, due today", "today"]);
  assert.deepEqual(titles(db.getUpcoming()), ["future", "future start, overdue deadline"]);
  assert.deepEqual(titles(db.getSomeday()), ["someday", "someday, due today"]);
  const anytime = titles(db.getAnytime());
  for (const hidden of ["in trashed project", "in completed project", "under trashed heading"]) assert.ok(!anytime.includes(hidden), hidden);
  assert.ok(!titles(db.getDeadlines().overdue).includes("in trashed project"));
  assert.equal(db.getStats().openTodos, 9);
});

test("a repeating template reads as a rule, never as a Someday to-do with a year-4001 deadline", () => {
  const [p, tpl, occ] = Array.from({ length: 3 }, generateUUID);
  const rr = rrOf({ fu: 256, of: [{ wd: 1 }], ts: -2 });
  const db = dbOf(
    project(p, { tt: "Garden" }),
    todo(tpl, { tt: "Water", rr, st: 2, sr: null, tir: day(2), icsd: day(2), dd: 64092211200, pr: [p] }),
    todo(occ, { tt: "Water", rt: [tpl], sr: day(0), tir: day(0), dd: day(0), pr: [p] })
  );
  const [template] = db.getRepeatingTodos();
  assert.equal(template.repeating, true);
  assert.equal(template.when, "repeating");
  assert.equal(template.deadline, null);
  assert.equal(template.scheduledDate, null);
  assert.equal(template.repeatRule, "Every week on Monday; each date is a deadline and the to-do starts 2 days before it");
  assert.deepEqual(
    [template.repeat.frequency, template.repeat.mode, template.repeat.hasDeadline, template.repeat.startsDaysBeforeDeadline, template.repeat.nextOccurrence],
    ["weekly", "fixed", true, 2, addDays(localDate(TZ), 2)]
  );

  const view = db.getProject(p);
  assert.deepEqual(view.ungroupedTasks.map((t) => [t.id, t.repeatTemplateId, t.repeating, t.deadline]), [[occ, tpl, undefined, localDate(TZ)]]);
  assert.deepEqual(view.repeatingTemplates.map((t) => t.id), [tpl]);
  assert.equal(db.getProjects()[0].openTasks, 1);
  assert.equal(db.getProjectStats().projects[0].totalTasks, 1);
  assert.deepEqual(db.search("water").map((t) => t.id), [occ]);
  assert.equal(db.getTask("Water").id, occ);
  assert.equal(db.getTask(tpl).repeating, true);
  assert.ok(!JSON.stringify([db.getRepeatingTodos(), view, db.getTrash(), db.getDeadlines(), db.getTask(tpl)]).includes("4001"));
});

test("repeat rules are described in words for every shape Things writes", () => {
  const say = (o, opts) => describeRepeatRule(rrOf(o), opts).summary;
  assert.equal(say({}), "Every day");
  assert.equal(say({ fa: 3 }), "Every 3 days");
  assert.equal(say({ fu: 256, fa: 2, of: [{ wd: 1 }, { wd: 4 }] }), "Every 2 weeks on Monday and Thursday");
  assert.equal(say({ fu: 8, of: [{ dy: 0 }, { dy: 14 }] }), "Every month on the 1st and the 15th");
  assert.equal(say({ fu: 8, of: [{ wdo: -1, wd: 5 }] }), "Every month on the last Friday");
  assert.equal(say({ fu: 8, of: [{ dy: -1 }] }), "Every month on the last day");
  assert.equal(say({ fu: 4, of: [{ dy: 19, mo: 10 }] }), "Every year on November 20");
  assert.equal(say({ fu: 4, of: [{ wdo: 4, mo: 10, wd: 4 }] }), "Every year on the 4th Thursday of November");
  assert.equal(say({ fa: 4, of: [], tp: 1, ia: 0 }), "Every 4 days after completion");
  assert.equal(describeRepeatRule(noEd({ rc: 5 })).summary, "Every day, 5 times");
  assert.equal(say({ ed: 1798675200 }), "Every day, until 2026-12-31");
  assert.equal(say({}, { hasDeadline: true }), "Every day; each occurrence has a deadline on its date");
  assert.equal(describeRepeatRule({ fu: 99 }).summary, "Repeats (rule not recognized)");
});

test("lookups by title prefer live items, and list filters match names as writes do", () => {
  const [a, liveP, deadP, live, dead] = Array.from({ length: 5 }, generateUUID);
  const db = dbOf(
    { [a]: { t: 0, e: "Area3", p: { tt: "Work", ix: 0 } } },
    project(deadP, { tt: "Taxes", tr: true }),
    project(liveP, { tt: "Taxes", ar: [a] }),
    todo(dead, { tt: "Call mom", tr: true }),
    todo(live, { tt: "Call mom", ar: [a] })
  );
  assert.equal(db.getTask("call mom").id, live);
  assert.equal(db.getProject("taxes").id, liveP);
  assert.equal(db.getProject(deadP).id, deadP);
  assert.deepEqual(db.getAnytime({ area: "work" }).map((t) => t.id), [live]);
  assert.deepEqual(db.getProjects({ area: "WORK" }).map((p) => p.id), [liveP]);
  assert.deepEqual(db.search("call", { area: "work" }).map((t) => t.id), [live]);
  assert.throws(() => db.getAnytime({ area: "Wrok" }), /No area found/);
  assert.throws(() => db.search("call", { tag: "nope" }), /No tag found/);
});

test("Logbook since and until are calendar days in the connector's time zone", () => {
  const at = (iso) => Date.parse(iso) / 1000;
  const done = (tt, iso) => todo(generateUUID(), { tt, ss: 3, sp: at(iso) });
  // 8 pm Eastern on Nov 8 is already Nov 9 in UTC; 9 pm Eastern on Nov 9 is Nov 10 in UTC.
  const db = dbOf(done("evening of the 8th", "2026-11-09T01:00:00Z"), done("evening of the 9th", "2026-11-10T02:00:00Z"));
  assert.deepEqual(db.getLogbook({ since: "2026-11-09", until: "2026-11-09" }).map((t) => t.title), ["evening of the 9th"]);
  assert.deepEqual(db.getLogbook({ since: "2026-11-09T00:00:00Z", until: "2026-11-09T23:59:59Z" }).map((t) => t.title), ["evening of the 8th"]);
});

// --- audit 2026-11-09: smaller write defects ---------------------------------------------------------------

test("import_json updates: repeated ids are merged, and checklist, reminder, and add-tags are applied", async () => {
  const [t, c, g1, g2] = Array.from({ length: 4 }, generateUUID);
  const { client, commits } = cloud([tag(g1), { [g2]: { t: 0, e: "Tag4", p: { tt: "second", ix: 0 } } }, todo(t, { sr: day(0), tir: day(0), tg: [g1] }), checklist(c, t)]);
  const upd = (attributes) => ({ type: "to-do", operation: "update", id: t, attributes });
  await client.importJson([upd({ title: "renamed" }), upd({ deadline: "2027-01-15" })]);
  assert.deepEqual([commits[0].body[t].p.tt, commits[0].body[t].p.dd], ["renamed", dateToTimestamp("2027-01-15")]);

  await client.importJson([upd({ "checklist-items": ["new"], "reminder-time": "09:30", "add-tags": ["second"] })]);
  const body = commits[1].body;
  assert.deepEqual(body[c], { t: 2, e: "ChecklistItem3", p: {} });
  const created = Object.values(body).filter((ch) => ch.e === "ChecklistItem3" && ch.t === 0);
  assert.deepEqual(created.map((ch) => [ch.p.tt, ch.p.ix]), [["new", 0]]);
  assert.equal(body[t].p.ato, 34200);
  assert.deepEqual(body[t].p.tg, [g1, g2]);

  await client.importJson([upd({ "append-checklist-items": ["more"] })]);
  const appended = Object.values(commits[2].body).filter((ch) => ch.e === "ChecklistItem3");
  assert.deepEqual(appended.map((ch) => [ch.t, ch.p.tt, ch.p.ix]), [[0, "more", 1]]);
  await assert.rejects(client.importJson([upd({ "prepend-checklist-items": ["first"] })]), /not supported/);
  assert.equal(commits.length, 3);
});

test("a tag title that already exists is refused, and a duplicate keeps checklist state", async () => {
  const [g, t, c1, c2] = Array.from({ length: 4 }, generateUUID);
  const { client, commits } = cloud([
    { [g]: { t: 0, e: "Tag4", p: { tt: "Work", ix: 0 } } },
    todo(t, { tt: "Pack" }),
    { [c1]: { t: 0, e: "ChecklistItem3", p: { tt: "done", ts: [t], ss: 3, sp: 1794000000, ix: 0 } } },
    { [c2]: { t: 0, e: "ChecklistItem3", p: { tt: "open", ts: [t], ss: 0, ix: 1 } } },
  ]);
  await assert.rejects(client.createTag({ title: "work" }), /already exists/);
  assert.equal(commits.length, 0);
  await client.updateTag(g, { title: "WORK" }); // renaming a tag to its own name in another case is fine
  await client.duplicateTodo(t);
  const items = Object.values(commits[1].body).filter((ch) => ch.e === "ChecklistItem3");
  assert.deepEqual(items.map((ch) => [ch.p.tt, ch.p.ss, ch.p.sp === null]), [["done", 3, false], ["open", 0, true]]);
});

test("a project batch with nothing to set is refused instead of reported as updated", async () => {
  const p = generateUUID();
  const { client, commits } = cloud([project(p)]);
  await assert.rejects(client.batchUpdateProjects([p], "set_dates"), /needs when, deadline/);
  assert.equal(commits.length, 0);
});

// --- audit 2026-11-09: login pages and tool output ------------------------------------------------------

test("login and error pages escape every interpolated value and are served with a script-blocking CSP", async () => {
  const attack = `"><script>alert(1)</script><img src=x onerror='x'>`;
  const page = loginPage({ clientName: attack, consentId: attack, queryParams: { state: attack }, error: attack });
  for (const html of [page, errorPage(attack)]) {
    assert.ok(!html.includes("<script"), "no script tag survives");
    assert.ok(!html.includes("<img src=x"), "no injected tag survives");
    assert.ok(!html.includes(`"><`), "no attribute is closed early");
  }
  assert.ok(page.includes("&#60;script&#62;alert(1)&#60;/script&#62;"));
  assert.match(page, /name="consentId" value="&#34;&#62;&#60;script/);

  const html = withSecurityHeaders(new Response(page, { status: 400, headers: { "Content-Type": "text/html; charset=UTF-8" } }));
  const csp = html.headers.get("Content-Security-Policy");
  assert.match(csp, /default-src 'none'/);
  assert.ok(!/script-src|unsafe-eval/.test(csp));
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(html.status, 400);
  assert.equal(await html.text(), page);
  const json = withSecurityHeaders(new Response("{}", { headers: { "Content-Type": "application/json" } }));
  assert.equal(json.headers.get("Content-Security-Policy"), null);
  assert.equal(json.headers.get("X-Content-Type-Options"), "nosniff");
});

test("things_get_account_info does not return the history key", () => {
  const source = readFileSync(new URL("../src/things-mcp.js", import.meta.url), "utf8");
  const start = source.indexOf('"things_get_account_info"');
  const tool = source.slice(start, source.indexOf("server.registerTool(", start));
  assert.ok(start > 0 && tool.includes("mailDropEmail"));
  assert.ok(!/historyKey/i.test(tool));
});

// --- creating repeating to-dos ----------------------------------------------------------------------

const nextDay = (n) => addDays(localDate(TZ), n);

test("a new repeating template must have the exact shape Things writes for one", () => {
  const start = nextDay(3);
  const make = (patch = {}) => {
    const change = buildRepeatingTaskCreate({ title: "Stretch", repeat: { frequency: "daily" }, start });
    Object.assign(change.p, patch);
    return { [generateUUID()]: change };
  };
  const db = dbOf();
  assert.doesNotThrow(() => validateChangeMap(make(), db));
  refused(make({ st: 1 }), db, /new repeating template needs st 2/);
  refused(make({ sr: day(3) }), db, /new repeating template needs sr null/);
  refused(make({ dd: day(9) }), db, /new repeating template needs dd null/);
  refused(make({ ato: 32400 }), db, /new repeating template needs ato null/);
  refused(make({ ss: 3, sp: 1794200000 }), db, /new repeating template needs ss 0/);
  refused(make({ tr: true }), db, /new repeating template needs tr false/);
  refused(make({ tp: 1 }), db, /new repeating template needs tp 0/);
  refused(make({ icc: 2 }), db, /new repeating template needs icc 0/);
  refused(make({ rt: [generateUUID()] }), db, /cannot name templates in rt/);
  refused(make({ tir: null }), db, /tir, icsd, and rr\.sr on the same first day/);
  refused(make({ icsd: day(4) }), db, /tir, icsd, and rr\.sr on the same first day/);
  refused(make({ tir: day(4), icsd: day(4) }), db, /tir, icsd, and rr\.sr on the same first day/);
  // A first day before today is refused once the database is known.
  const past = { [generateUUID()]: buildRepeatingTaskCreate({ title: "Stretch", repeat: { frequency: "daily" }, start: nextDay(-2) }) };
  refused(past, db, /cannot start before today/);
});

test("things_add_todo with repeat: writes one template and reads it back as repeating", async () => {
  const tagId = generateUUID();
  const { client, commits } = cloud([tag(tagId)]);
  const start = nextDay(7);
  const weekday = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(dateToTimestamp(start) * 1000).getUTCDay()];
  const ends = nextDay(60);
  const result = await client.createTodo({
    title: "Take out recycling",
    notes: "Blue bin",
    tags: [tagId],
    checklist: ["Flatten boxes"],
    repeat: { frequency: "weekly", interval: 2, weekdays: [weekday], starts: start, ends: { on: ends } },
  });
  assert.equal(commits.length, 1);
  const p = commits[0].body[result.id].p;
  const ts = dateToTimestamp(start);
  assert.equal(commits[0].body[result.id].t, 0);
  assert.equal(commits[0].body[result.id].e, "Task6");
  assert.deepEqual(
    { st: p.st, sb: p.sb, sr: p.sr, tir: p.tir, icsd: p.icsd, ato: p.ato, dd: p.dd, icc: p.icc, ss: p.ss, tg: p.tg },
    { st: 2, sb: 0, sr: null, tir: ts, icsd: ts, ato: null, dd: null, icc: 0, ss: 0, tg: [tagId] }
  );
  assert.equal(
    JSON.stringify(p.rr),
    JSON.stringify({ fu: 256, fa: 2, of: [{ wd: new Date(ts * 1000).getUTCDay() }], tp: 0, ia: ts, sr: ts, rc: 0, ts: 0, rrv: 4, ed: dateToTimestamp(ends) })
  );
  assert.deepEqual(repeatRuleProblems(p.rr), []);
  assert.equal(Object.keys(commits[0].body).length, 2); // the template and its checklist item, no occurrences

  assert.equal(result.repeating, true);
  assert.equal(result.when, "repeating");
  assert.equal(result.firstOccurrence, start);
  assert.match(result.repeatRule, /^Every 2 weeks on /);

  const db = await client.syncDatabase();
  const read = db.getRepeatingTodos().find((t) => t.id === result.id);
  assert.equal(read.repeating, true);
  assert.equal(read.when, "repeating");
  assert.equal(read.repeatRule, result.repeatRule);
  assert.equal(read.repeat.frequency, "weekly");
  assert.equal(read.repeat.interval, 2);
});

test("things_add_todo with repeat: the first day defaults to the next matching day, and when may name it", async () => {
  const { client, commits } = cloud();
  const a = await client.createTodo({ title: "Daily", repeat: { frequency: "daily" } });
  assert.equal(a.firstOccurrence, localDate(TZ));
  assert.equal(commits[0].body[a.id].p.tir, today());
  const b = await client.createTodo({ title: "Daily", when: "tomorrow", repeat: { frequency: "daily", ends: { after: 5 } } });
  assert.equal(b.firstOccurrence, nextDay(1));
  assert.equal(commits[1].body[b.id].p.rr.rc, 5);
  assert.ok(!("ed" in commits[1].body[b.id].p.rr));
  const c = await client.createTodo({ title: "After", when: nextDay(2), repeat: { frequency: "daily", interval: 4, after_completion: true, starts: nextDay(2) } });
  assert.deepEqual(commits[2].body[c.id].p.rr, { fu: 16, fa: 4, of: [], tp: 1, ia: 0, sr: day(2), rc: 0, ts: 0, rrv: 4, ed: 64092211200 });
});

test("things_add_todo with repeat: contradictory or unsupported input is refused with nothing written", async () => {
  const { client, commits } = cloud();
  const no = (args, pattern) => assert.rejects(client.createTodo({ title: "x", ...args }), pattern);
  const daily = { frequency: "daily" };
  for (const when of ["inbox", "anytime", "someday", "evening"]) await no({ when, repeat: daily }, /cannot be scheduled for/);
  await no({ when: nextDay(1), repeat: { ...daily, starts: nextDay(2) } }, /name different first days/);
  await no({ repeat: { ...daily, starts: nextDay(-1) } }, /cannot start in the past/);
  await no({ repeat: daily, reminderTime: "09:00" }, /cannot be created with a reminder time/);
  await no({ repeat: daily, deadline: nextDay(5) }, /cannot be created with a deadline/);
  await no({ repeat: daily, completed: true }, /completed or canceled/);
  await no({ repeat: daily, canceled: true }, /completed or canceled/);
  await no({ repeat: { frequency: "weekly", weekdays: ["mon"], after_completion: true } }, /Supported repeats/);
  await no({ repeat: { frequency: "yearly", month: 11, nth_weekday: { nth: "last", weekday: "thu" } } }, /not supported/);
  await no({ repeat: { ...daily, ends: { on: nextDay(-1) } } }, /before the first day/);
  assert.equal(commits.length, 0);
});

test("tool descriptions say that repeat rules cannot be edited or cleared", () => {
  const source = readFileSync(new URL("../src/things-mcp.js", import.meta.url), "utf8");
  for (const name of ["things_add_todo", "things_get_repeating_todos"]) {
    const start = source.indexOf(`"${name}"`);
    const tool = source.slice(start, source.indexOf("server.registerTool(", start));
    assert.match(tool, /cannot be edited or cleared/, name);
    assert.match(tool, /trashing the template/i, name);
  }
});
