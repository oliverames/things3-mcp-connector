// Regression tests for the write-safety validator, the commit path, and the read path. Every fetch
// is mocked: nothing here talks to Things Cloud.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loginPage, errorPage, withSecurityHeaders } from "../src/pages.js";
import { encryptJson, encryptJsonLegacy, decryptJson, decryptJsonDetailed, readStoredCredentials, upgradeGrantProps } from "../src/credential-crypto.js";
import { ThingsHandler } from "../src/things-handler.js";
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
  // The update is rebuilt against the fresh state, where the project no longer resolves.
  await assert.rejects(client.updateTodo(t, { project: p }), /No project found.*nothing was written/);
  assert.equal(commits.length, 1);
});

test("a plain patch is resent unchanged after a conflict, and still re-validated", async () => {
  const [p, t] = [generateUUID(), generateUUID()];
  const gone = cloud([project(p), todo(t)], {
    onCommit: (n, body, history) => {
      if (n === 1) {
        history.push({ [p]: { t: 2, e: "Task6", p: {} } });
        return new Response("conflict", { status: 409 });
      }
    },
  });
  await assert.rejects(gone.client.commitChanges([{ [t]: { t: 1, e: "Task6", p: { pr: [p], st: 1 } } }]), /pr reference/);
  assert.equal(gone.commits.length, 1);

  const other = generateUUID();
  const ok = cloud([todo(t)], {
    onCommit: (n, body, history) => {
      if (n === 1) {
        history.push(todo(other));
        return new Response("conflict", { status: 409 });
      }
    },
  });
  await ok.client.commitChanges([{ [t]: { t: 1, e: "Task6", p: { tt: "renamed", md: 1794000000 } } }]);
  assert.equal(ok.commits.length, 2);
  assert.deepEqual(ok.commits[1].body, ok.commits[0].body);
  assert.match(ok.commits[1].url, /ancestor-index=2/);
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

test("tool descriptions point at things_update_repeat for editing, pausing, and stopping a repeat", () => {
  const source = readFileSync(new URL("../src/things-mcp.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /cannot be edited or cleared/);
  for (const name of ["things_add_todo", "things_get_repeating_todos", "things_update_repeat"]) {
    const start = source.indexOf(`"${name}"`);
    const tool = source.slice(start, source.indexOf("server.registerTool(", start));
    assert.match(tool, /things_update_repeat/, name);
    assert.match(tool, /pause/, name);
    assert.match(tool, /stop/, name);
  }
});

// --- password encoding ------------------------------------------------------------------------------

test("encodePassword escapes once, exactly as the Swift client does", () => {
  assert.equal(ThingsCloudClient.encodePassword("p@ss w!rd*'()~"), "p%40ss%20w%21rd%2A%27%28%29~");
  assert.equal(ThingsCloudClient.encodePassword("100%"), "100%25");
});

// --- closing a project closes its open to-dos -------------------------------------------------------

// A project with a heading, a trashed heading, and one to-do of every kind the close must tell apart.
function projectFixture() {
  const ids = Object.fromEntries(
    ["proj", "head", "deadHead", "open", "underHead", "done", "canceled", "trashed", "underDeadHead", "template", "elsewhere"].map((k) => [k, generateUUID()])
  );
  const template = { [ids.template]: buildRepeatingTaskCreate({ title: "daily", repeat: { frequency: "daily" }, start: localDate(TZ), project: ids.proj, timeZone: TZ }) };
  const items = [
    project(ids.proj),
    heading(ids.head, ids.proj),
    heading(ids.deadHead, ids.proj, { tr: true }),
    todo(ids.open, { pr: [ids.proj] }),
    todo(ids.underHead, { agr: [ids.head] }),
    todo(ids.done, { pr: [ids.proj], ss: 3, sp: 1700000000 }),
    todo(ids.canceled, { pr: [ids.proj], ss: 2, sp: 1700000000 }),
    todo(ids.trashed, { pr: [ids.proj], tr: true }),
    todo(ids.underDeadHead, { agr: [ids.deadHead] }),
    template,
    todo(ids.elsewhere),
  ];
  return { ids, items };
}

test("completing a project completes its open to-dos in the same commit and nothing else", async () => {
  const { ids, items } = projectFixture();
  const { client, commits } = cloud(items);
  const result = await client.updateProject(ids.proj, { status: "completed" });
  assert.equal(commits.length, 1);
  const body = commits[0].body;
  assert.deepEqual(Object.keys(body).sort(), [ids.proj, ids.open, ids.underHead].sort());
  const { md, sp } = body[ids.proj].p;
  assert.equal(body[ids.proj].p.ss, 3);
  for (const id of [ids.open, ids.underHead]) assert.deepEqual(body[id], { t: 1, e: "Task6", p: { md, ss: 3, sp } });
  assert.deepEqual(result, { id: ids.proj, updated: true, todosClosed: 2 });
});

test("a completion date on the project is the stop date of the to-dos closed with it", async () => {
  const { ids, items } = projectFixture();
  const { client, commits } = cloud(items);
  await client.updateProject(ids.proj, { status: "completed", completionDate: "2026-01-02T03:04:05Z" });
  const body = commits[0].body;
  assert.equal(body[ids.proj].p.sp, 1767323045);
  assert.equal(body[ids.open].p.sp, 1767323045);
});

test("canceling projects in a batch cancels their open to-dos and reports the count", async () => {
  const { ids, items } = projectFixture();
  const empty = generateUUID();
  const { client, commits } = cloud([...items, project(empty)]);
  const result = await client.batchUpdateProjects([ids.proj, empty], "cancel");
  const body = commits[0].body;
  assert.deepEqual(Object.keys(body).sort(), [ids.proj, empty, ids.open, ids.underHead].sort());
  const { md, sp } = body[ids.proj].p;
  for (const id of [ids.open, ids.underHead]) assert.deepEqual(body[id].p, { md, ss: 2, sp });
  assert.equal(result.todosClosed, 2);
  assert.deepEqual(result.items.map((i) => i.todosClosed), [2, 0]);
});

test("reopening, trashing, or editing a project leaves its to-dos alone", async () => {
  const { ids, items } = projectFixture();
  const { client, commits } = cloud(items);
  await client.updateProject(ids.proj, { status: "completed" });
  const reopened = await client.updateProject(ids.proj, { status: "open" });
  assert.deepEqual(Object.keys(commits[1].body), [ids.proj]);
  assert.equal("todosClosed" in reopened, false);
  await client.updateProject(ids.proj, { title: "renamed" });
  assert.deepEqual(Object.keys(commits[2].body), [ids.proj]);
  const batch = await client.batchUpdateProjects([ids.proj], "trash");
  assert.deepEqual(Object.keys(commits[3].body), [ids.proj]);
  assert.equal("todosClosed" in batch, false);
  assert.equal("todosClosed" in batch.items[0], false);
});

test("an import_json update that closes a project closes its to-dos, one change per id", async () => {
  const { ids, items } = projectFixture();
  const { client, commits } = cloud(items);
  const result = await client.importJson([
    { type: "to-do", operation: "update", id: ids.open, attributes: { title: "renamed" } },
    { type: "project", operation: "update", id: ids.proj, attributes: { canceled: true } },
  ]);
  const body = commits[0].body;
  assert.deepEqual(Object.keys(body).sort(), [ids.proj, ids.open, ids.underHead].sort());
  const { md, sp } = body[ids.proj].p;
  assert.deepEqual(body[ids.open].p, { md, tt: "renamed", ss: 2, sp });
  assert.deepEqual(body[ids.underHead].p, { md, ss: 2, sp });
  assert.equal(result.items.find((i) => i.id === ids.proj).todosClosed, 2);
});

// --- editing, pausing, and stopping a repeat (shapes sampled from Things 3.24.2 on 2026-11-09) ----------

// The sampled history: project, today's occurrence, and the daily template whose next day is
// 2026-11-10. The clock is set to the moment of each sampled write, so dates and md compare exactly
// (to the millisecond; the samples carry microseconds).
const S = {
  project: "XN4eGArARmEF2vzS84p12i",
  occurrence: "7FxH2V7SdsAwEvq59evaxb",
  template: "LFwb2zkVA7nCqRm1BMEfkk",
  nov9: 1794182400,
  nov10: 1794268800,
};
const sampledTask = (p) => {
  const create = buildTaskCreate({ title: "Repeat edit sample", when: "anytime", project: S.project, now: 1794274800, timeZone: TZ });
  return { t: 0, e: "Task7", p: { ...create.p, ...p } };
};
const sampledHistory = (templateProps = {}) => [
  { [S.project]: { t: 0, e: "Task7", p: { ...buildTaskCreate({ title: "Samples", type: 1, when: "anytime", now: 1794274700, timeZone: TZ }).p } } },
  { [S.occurrence]: sampledTask({ st: 1, sr: S.nov9, tir: S.nov9, rt: [S.template] }) },
  {
    [S.template]: sampledTask({
      sr: null,
      st: 2,
      tir: S.nov10,
      icc: 1,
      icsd: S.nov10,
      md: 1794274843.07671,
      rr: { of: [{ dy: 0 }], rrv: 4, tp: 0, ts: 0, fu: 16, ia: S.nov9, fa: 1, sr: S.nov9, rc: 0, ed: 64092211200 },
      ...templateProps,
    }),
  },
];
const at = (t, seconds) => t.mock.timers.enable({ apis: ["Date"], now: Math.round(seconds * 1000) });
const ms = (seconds) => Math.round(seconds * 1000) / 1000;

test("things_update_repeat rule: writes md and the new rr on the template, exactly as sampled", async (t) => {
  at(t, 1794274921.023453);
  const { client, commits } = cloud(sampledHistory());
  // An occurrence id resolves to its template through rt.
  const result = await client.updateRepeat(S.occurrence, { action: "rule", repeat: { frequency: "weekly", weekdays: ["tue"] } });
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].body, {
    [S.template]: {
      t: 1,
      e: "Task6",
      p: { md: ms(1794274921.023453), rr: { of: [{ wd: 2 }], rrv: 4, tp: 0, ts: 0, fu: 256, ia: 1794268800, fa: 1, sr: 1794182400, rc: 0, ed: 64092211200 } },
    },
  });
  assert.deepEqual([result.id, result.repeatRule, result.nextOccurrence], [S.template, "Every week on Tuesday", "2026-11-10"]);
  const read = (await client.syncDatabase()).getTask(S.template);
  assert.deepEqual([read.repeatRule, read.repeat.nextOccurrence, read.repeat.paused], ["Every week on Tuesday", "2026-11-10", false]);
  // repeat.starts may name the unchanged next day.
  await client.updateRepeat(S.template, { action: "rule", repeat: { frequency: "daily", starts: "2026-11-10" } });
  assert.deepEqual(Object.keys(commits[1].body[S.template].p).sort(), ["md", "rr"]);
  assert.deepEqual([commits[1].body[S.template].p.rr.ia, commits[1].body[S.template].p.rr.sr], [S.nov10, S.nov9]);
});

// Second sampling session: a daily template (created by the connector) whose next day is
// 2026-11-10, changed to weekly on Friday in the app. The app also rewrote ti, which is incidental
// and not written here.
const MOVE_TEMPLATE = "QWDpWqkzjS5Tny3BX2js2X";
const SAMPLED_MOVE = JSON.parse(
  '{"ti":-543,"rr":{"of":[{"wd":5}],"rrv":4,"tp":0,"ts":0,"fu":256,"ia":1794268800,"fa":1,"sr":1794182400,"rc":0,"ed":64092211200},"md":1794276589.185753,"icsd":1794528000,"tir":1794528000}'
);
const moveHistory = (templateProps = {}) => {
  const [project, , template] = sampledHistory(templateProps);
  return [project, { [MOVE_TEMPLATE]: template[S.template] }];
};

test("things_update_repeat rule: a rule that moves the next day writes md, rr, tir, and icsd, exactly as sampled", async (t) => {
  at(t, 1794276589.185753);
  const { client, commits } = cloud(moveHistory());
  const result = await client.updateRepeat(MOVE_TEMPLATE, { action: "rule", repeat: { frequency: "weekly", weekdays: ["fri"] } });
  assert.equal(commits.length, 1);
  const { ti, ...sampled } = SAMPLED_MOVE;
  assert.equal(ti, -543);
  assert.deepEqual(commits[0].body, { [MOVE_TEMPLATE]: { t: 1, e: "Task6", p: { ...sampled, md: ms(1794276589.185753) } } });
  assert.deepEqual(Object.keys(commits[0].body[MOVE_TEMPLATE].p), ["rr", "md", "icsd", "tir"]);
  assert.deepEqual([result.repeatRule, result.nextOccurrence, result.previousNextOccurrence, result.nextDayMoved], ["Every week on Friday", "2026-11-13", "2026-11-10", true]);
  const read = (await client.syncDatabase()).getTask(MOVE_TEMPLATE);
  assert.deepEqual([read.repeatRule, read.repeat.nextOccurrence], ["Every week on Friday", "2026-11-13"]);

  // repeat.starts names a later day the rule falls on, even when the rule also falls on the current one.
  const later = cloud(moveHistory());
  const r2 = await later.client.updateRepeat(MOVE_TEMPLATE, { action: "rule", repeat: { frequency: "daily", starts: "2026-11-12" } });
  const p2 = later.commits[0].body[MOVE_TEMPLATE].p;
  assert.deepEqual(Object.keys(p2).sort(), ["icsd", "md", "rr", "tir"]);
  assert.deepEqual([p2.tir, p2.icsd, p2.rr.ia, p2.rr.sr, r2.nextOccurrence], [1794441600, 1794441600, S.nov10, S.nov9, "2026-11-12"]);

  // A next day left in the past moves to the first matching day counted from today (2026-11-09), not from it.
  const nov3 = 1793664000;
  const stale = cloud(moveHistory({ tir: nov3, icsd: nov3 }));
  const r3 = await stale.client.updateRepeat(MOVE_TEMPLATE, { action: "rule", repeat: { frequency: "weekly", weekdays: ["wed", "sat"] } });
  const p3 = stale.commits[0].body[MOVE_TEMPLATE].p;
  assert.deepEqual([p3.tir, p3.icsd, p3.rr.ia, r3.nextOccurrence], [1794355200, 1794355200, nov3, "2026-11-11"]);
  const stale2 = cloud(moveHistory({ tir: nov3, icsd: nov3 }));
  await assert.rejects(stale2.client.updateRepeat(MOVE_TEMPLATE, { action: "rule", repeat: { frequency: "daily", starts: "2026-11-05" } }), /repeat\.starts \(2026-11-05\) is in the past/);
  assert.equal(stale2.commits.length, 0);

  // The validator accepts exactly the sampled move and refuses each near miss.
  const db = await cloud(moveHistory()).client.syncDatabase();
  const upd = (p) => ({ [MOVE_TEMPLATE]: { t: 1, e: "Task6", p } });
  const good = { ...sampled, md: 1794276589.186 };
  const fri = 1794528000;
  assert.doesNotThrow(() => validateChangeMap(upd(good), db));
  refused(upd({ ...good, ti: -543 }), db, /ti would change a repeating template/);
  refused(upd({ ...good, icc: 1 }), db, /icc would change a repeating template/);
  refused(upd({ md: good.md, rr: good.rr, tir: fri }), db, /tir would change a repeating template/);
  refused(upd({ md: good.md, rr: good.rr, icsd: fri }), db, /icsd would change a repeating template/);
  refused(upd({ md: good.md, tir: fri, icsd: fri }), db, /tir would change a repeating template/);
  refused(upd({ md: good.md, rr: good.rr }), db, /does not fall on the template's next day 2026-11-10/);
  refused(upd({ ...good, icsd: fri + 86400 }), db, /tir and icsd must both be the new next day/);
  refused(upd({ ...good, icsd: null }), db, /tir and icsd must both be the new next day/);
  refused(upd({ ...good, tir: S.nov10, icsd: S.nov10 }), db, /can only move later than 2026-11-10/);
  refused(upd({ ...good, tir: S.nov9, icsd: S.nov9 }), db, /can only move later/);
  refused(upd({ ...good, tir: fri - 86400, icsd: fri - 86400 }), db, /does not fall on the new next day 2026-11-12/);
  refused(upd({ ...good, rr: { ...good.rr, ia: fri } }), db, /rr\.ia must be the template's next day \(tir\) before the edit/);
  refused(upd({ ...good, rr: { ...good.rr, sr: S.nov10 } }), db, /rr\.sr must stay the old rule's sr/);
  refused(upd({ ...good, rr: { ...good.rr, ed: S.nov10 + 86400 } }), db, /ends before the new next day/);
  refused(upd({ ...good, rr: null }), db, /cannot be cleared/);
  const staleDb = await cloud(moveHistory({ tir: nov3, icsd: nov3 })).client.syncDatabase();
  const nov6 = 1793923200;
  refused(upd({ ...good, rr: { ...good.rr, ia: nov3 }, tir: nov6, icsd: nov6 }), staleDb, /cannot be before today/);
  const pausedDb = await cloud(moveHistory({ icp: true })).client.syncDatabase();
  refused(upd(good), pausedDb, /the template is paused/);
});

test("things_update_repeat rule: unsampled cases are refused with nothing written", async (t) => {
  at(t, 1794274921.023453);
  const { client, commits } = cloud(sampledHistory());
  const no = (id, args, pattern) => assert.rejects(client.updateRepeat(id, args), pattern);
  const rule = (repeat) => ({ action: "rule", repeat });
  await no(S.template, rule({ frequency: "daily", starts: "2026-11-09" }), /repeat\.starts \(2026-11-09\) is before the next day of this repeat \(2026-11-10\).*earlier was not sampled/);
  await no(S.template, rule({ frequency: "weekly", weekdays: ["fri"], starts: "2026-11-12" }), /2026-11-12 is not a day the new rule falls on\. The next one is 2026-11-13/);
  await no(S.template, rule({ frequency: "weekly", weekdays: ["fri"], starts: "2026-11-10" }), /2026-11-10 is not a day the new rule falls on\. The next one is 2026-11-13/);
  await no(S.template, rule({ frequency: "weekly", weekdays: ["fri"], ends: { on: "2026-11-11" } }), /repeat\.ends\.on 2026-11-11 is before the new next day 2026-11-13/);
  await no(S.template, rule({ frequency: "daily", starts: "soon" }), /repeat\.starts must be a date/);
  await no(S.template, rule({ frequency: "daily", interval: 4, after_completion: true }), /after completion was not sampled/);
  await no(S.template, rule({ frequency: "hourly" }), /Supported repeats/);
  await no(S.template, { action: "rule" }, /needs a repeat object/);
  await no(S.template, { action: "pause", repeat: { frequency: "daily" } }, /"rule" action only/);
  await no(S.template, { action: "clear" }, /action must be/);
  await no(S.project, { action: "pause" }, /is a project, not a to-do/);
  assert.equal(commits.length, 0);

  // A paused template, an after-completion rule, and a plain to-do.
  const plain = generateUUID();
  const paused = cloud([...sampledHistory({ icp: true }), { [plain]: buildTaskCreate({ title: "plain", timeZone: TZ }) }]);
  await assert.rejects(paused.client.updateRepeat(S.template, rule({ frequency: "weekly", weekdays: ["tue"] })), /is paused.*Resume it first/);
  await assert.rejects(paused.client.updateRepeat(plain, { action: "pause" }), /is not a repeating to-do/);
  const after = cloud(sampledHistory({ rr: { fu: 16, fa: 4, of: [], tp: 1, ia: 0, sr: S.nov9, rc: 0, ts: 0, rrv: 4, ed: 64092211200 } }));
  await assert.rejects(after.client.updateRepeat(S.template, rule({ frequency: "daily" })), /not a plain fixed-schedule rule/);
  assert.equal(paused.commits.length + after.commits.length, 0);

  // The validator holds the same line for any other writer.
  const db = await client.syncDatabase();
  const upd = (p) => ({ [S.template]: { t: 1, e: "Task6", p } });
  const rr = { of: [{ wd: 2 }], rrv: 4, tp: 0, ts: 0, fu: 256, ia: S.nov10, fa: 1, sr: S.nov9, rc: 0, ed: 64092211200 };
  assert.doesNotThrow(() => validateChangeMap(upd({ md: 1794274921.023, rr }), db));
  refused(upd({ rr }), db, /a rule edit writes exactly md and rr/);
  refused(upd({ md: 1794274921.023, rr, tir: S.nov10 }), db, /tir would change a repeating template/);
  refused(upd({ md: 1794274921.023, rr: null }), db, /cannot be cleared/);
  refused(upd({ md: 1794274921.023, rr: { ...rr, sr: S.nov10 } }), db, /rr\.sr must stay the old rule's sr/);
  refused(upd({ md: 1794274921.023, rr: { ...rr, ia: S.nov9 } }), db, /rr\.ia must be the template's next day/);
  refused(upd({ md: 1794274921.023, rr: { ...rr, of: [{ wd: 3 }] } }), db, /does not fall on the template's next day 2026-11-10/);
  refused(upd({ md: 1794274921.023, rr: { ...rr, fu: 16, of: [], tp: 1, ia: 0 } }), db, /only a fixed-schedule rule/);
  refused(upd({ icp: true }), db, /pause and resume write exactly icp and md/);
  refused(upd({ icp: "yes", md: 1794274921.023 }), db, /icp must be a boolean/);
  refused({ [S.occurrence]: { t: 1, e: "Task6", p: { icp: true, md: 1794274921.023 } } }, db, /icp applies to repeating templates only/);
});

test("things_update_repeat pause and resume: write icp and md on the template, exactly as sampled", async (t) => {
  at(t, 1794274947.122859);
  const { client, commits } = cloud(sampledHistory());
  const paused = await client.updateRepeat(S.template, { action: "pause" });
  assert.deepEqual(commits[0].body, { [S.template]: { t: 1, e: "Task6", p: { icp: true, md: ms(1794274947.122859) } } });
  assert.deepEqual([paused.changed, paused.paused], [true, true]);
  const db = await client.syncDatabase();
  assert.equal(db.getTask(S.template).repeat.paused, true);
  assert.equal(db.getRepeatingTodos()[0].repeat.paused, true);
  // Pausing a paused repeat writes nothing.
  assert.deepEqual((await client.updateRepeat(S.occurrence, { action: "pause" })).changed, false);
  assert.equal(commits.length, 1);

  t.mock.timers.setTime(Math.round(1794274971.49046 * 1000));
  await client.updateRepeat(S.occurrence, { action: "resume" });
  assert.deepEqual(commits[1].body, { [S.template]: { t: 1, e: "Task6", p: { icp: false, md: ms(1794274971.49046) } } });
  assert.equal((await client.syncDatabase()).getTask(S.template).repeat.paused, false);
  assert.equal((await client.updateRepeat(S.template, { action: "resume" })).changed, false);
  assert.equal(commits.length, 2);
});

// The sampled create, verbatim, with cd left to the clock.
const SAMPLED_STOP_CREATE = JSON.parse(
  '{"tp":0,"sr":1794268800,"dds":null,"rt":[],"rmd":null,"ss":0,"tr":false,"dl":[],"icp":false,"st":2,"ar":[],"tt":"Repeat edit sample","do":0,"lai":null,"tir":1794268800,"tg":[],"agr":[],"ix":0,"cd":1794274999.166278,"lt":true,"icc":0,"ti":0,"md":null,"dd":null,"ato":null,"nt":{"_t":"tx","ch":0,"v":"","t":1},"icsd":null,"pr":["XN4eGArARmEF2vzS84p12i"],"rp":null,"acrd":null,"sp":null,"sb":0,"rr":null,"xx":{"sn":{},"_t":"oo"}}'
);

test("things_update_repeat stop: one commit with the sampled create, detach, and tombstone", async (t) => {
  at(t, 1794274999.166278);
  const { client, commits } = cloud(sampledHistory());
  const result = await client.updateRepeat(S.template, { action: "stop" });
  assert.equal(commits.length, 1);
  const body = commits[0].body;
  const ids = Object.keys(body);
  assert.deepEqual(ids.slice(1), [S.occurrence, S.template]);
  assert.equal(ids.length, 3);
  assert.equal(ids[0], result.newTodoId);
  const create = body[ids[0]];
  assert.deepEqual([create.t, create.e], [0, "Task6"]);
  assert.deepEqual(Object.keys(create.p), Object.keys(SAMPLED_STOP_CREATE));
  assert.deepEqual(create.p, { ...SAMPLED_STOP_CREATE, cd: ms(1794274999.166278) });
  assert.deepEqual(body[S.occurrence], { t: 1, e: "Task6", p: { rt: [] } });
  assert.deepEqual(body[S.template], { t: 2, e: "Task6", p: {} });
  assert.deepEqual([result.scheduledDate, result.detachedOccurrences], ["2026-11-10", [S.occurrence]]);

  const db = await client.syncDatabase();
  assert.deepEqual(db.getRepeatingTodos(), []);
  assert.equal(db.getTask(S.occurrence).repeatTemplateId, undefined);
  const made = db.getTask(result.newTodoId);
  assert.deepEqual([made.title, made.when, made.projectId, made.repeating], ["Repeat edit sample", "2026-11-10", S.project, undefined]);
});

test("things_update_repeat stop: every open occurrence is detached, completed and trashed ones are left alone, template fields are copied", async (t) => {
  at(t, 1794274999.166278);
  const [open2, done, trashed, g, a] = Array.from({ length: 5 }, generateUUID);
  const occ = (p) => sampledTask({ st: 1, sr: S.nov9, tir: S.nov9, rt: [S.template], ...p });
  const { client, commits } = cloud([
    { [g]: { t: 0, e: "Tag4", p: { tt: "home", sh: null, pn: [], ix: 0, xx: { sn: {}, _t: "oo" } } } },
    { [a]: { t: 0, e: "Area3", p: { tt: "Life", tg: [], ix: 0, xx: { sn: {}, _t: "oo" } } } },
    ...sampledHistory({ tt: "Water plants", nt: noteObject("two cups"), tg: [g], pr: [], ar: [a], ix: -417 }),
    { [open2]: occ({}) },
    { [done]: occ({ ss: 3, sp: 1794270000 }) },
    { [trashed]: occ({ tr: true }) },
  ]);
  const result = await client.updateRepeat(open2, { action: "stop" });
  const body = commits[0].body;
  assert.deepEqual(Object.keys(body), [result.newTodoId, S.occurrence, open2, S.template]);
  assert.deepEqual(body[S.occurrence], { t: 1, e: "Task6", p: { rt: [] } });
  assert.deepEqual(body[open2], { t: 1, e: "Task6", p: { rt: [] } });
  assert.deepEqual(body[S.template], { t: 2, e: "Task6", p: {} });
  assert.deepEqual(body[result.newTodoId].p, {
    ...SAMPLED_STOP_CREATE,
    cd: ms(1794274999.166278),
    tt: "Water plants",
    nt: noteObject("two cups"),
    tg: [g],
    pr: [],
    ar: [a],
    ix: -417,
  });
  assert.deepEqual(result.detachedOccurrences, [S.occurrence, open2]);
  const db = await client.syncDatabase();
  assert.deepEqual([db.tasks.get(done).repeatingTemplates, db.tasks.get(trashed).repeatingTemplates], [[S.template], [S.template]]);
});

test("things_update_repeat stop: unsampled cases are refused, and the validator only passes the stop shapes together", async (t) => {
  at(t, 1794274999.166278);
  const stop = (history) => {
    const c = cloud(history);
    return [assert.rejects.bind(null, c.client.updateRepeat(S.template, { action: "stop" })), c];
  };
  const [paused, c2] = stop(sampledHistory({ icp: true }));
  await paused(/is paused.*Resume it first/);
  const [withReminder, c3] = stop(sampledHistory({ ato: 32400 }));
  await withReminder(/adds deadlines or reminders/);
  const [withDeadline, c4] = stop(sampledHistory({ dd: 64092211200 }));
  await withDeadline(/adds deadlines or reminders/);
  const [dueToday, c5] = stop(sampledHistory({ tir: S.nov9, icsd: S.nov9 }));
  await dueToday(/next day of the repeating to-do \S+ is 2026-11-09; only a repeat whose next day is in the future/);
  const [inTrash, c6] = stop(sampledHistory({ tr: true }));
  await inTrash(/is in the Trash/);
  assert.equal([c2, c3, c4, c5, c6].reduce((n, c) => n + c.commits.length, 0), 0);

  const { client } = cloud(sampledHistory());
  const db = await client.syncDatabase();
  const id = generateUUID();
  const create = { t: 0, e: "Task6", p: { ...SAMPLED_STOP_CREATE } };
  const detach = { [S.occurrence]: { t: 1, e: "Task6", p: { rt: [] } } };
  const tombstone = { [S.template]: { t: 2, e: "Task6", p: {} } };
  assert.doesNotThrow(() => validateChangeMap({ [id]: create, ...detach, ...tombstone }, db));
  refused({ [id]: create }, db, /must come with the tombstone of exactly one repeating template/);
  refused({ ...detach }, db, /rt would change a repeating occurrence/);
  refused({ ...detach, [S.occurrence]: { t: 1, e: "Task6", p: { rt: [], md: 1794274999 } }, [id]: create, ...tombstone }, db, /rt would change a repeating occurrence/);
  refused({ [id]: create, ...tombstone }, db, /repeat template still references deleted item/);
  const bad = (p, pattern) => refused({ [id]: { ...create, p: { ...create.p, ...p } }, ...detach, ...tombstone }, db, pattern);
  bad({ md: 1794274999 }, /needs md null/);
  bad({ lt: false }, /needs lt true/);
  bad({ st: 1 }, /needs st 2/);
  bad({ icsd: S.nov10 }, /needs icsd null/);
  bad({ tir: S.nov9 }, /sr and tir on the same day/);
  bad({ sr: 1794355200, tir: 1794355200 }, /must be on the template's next day/);
});

// Second sampling session: Stop on a template with notes, one tag, and two checklist items.
const B = {
  project: "JVH7o2GV7gnw7YsLPKuCZP",
  tag: "H96sVJwE7VJveAnv7itmux",
  template: "42z5x6HRuXwRLnakSF6teh",
  occurrence: "2ERKk97mjgwvtiBNL8cYVZ",
  one: "TKnz93jLYf8GVtyVrDmG5e",
  two: "JSvw5KYxebS5HuDk6u2jz1",
  sampledNewTodo: "UigGY7zyRphxNeq29WvYSn",
};
const SAMPLED_STOP_B = {
  ...SAMPLED_STOP_CREATE,
  ...JSON.parse('{"tt":"Stop sample B","sr":1794268800,"tir":1794268800,"st":2,"lt":true,"md":null,"ato":null,"dd":null,"rt":[],"rr":null,"ix":0,"ti":0,"tg":["H96sVJwE7VJveAnv7itmux"],"nt":{"t":1,"ch":2335530048,"v":"Sample **notes**","_t":"tx"},"pr":["JVH7o2GV7gnw7YsLPKuCZP"]}'),
};
const SAMPLED_STOP_B_ITEMS = [
  JSON.parse('{"ix":0,"cd":1794276623.623518,"ts":["UigGY7zyRphxNeq29WvYSn"],"sp":null,"ss":0,"xx":{"sn":{},"_t":"oo"},"tt":"One","md":null,"lt":true}'),
  JSON.parse('{"lt":true,"cd":1794276623.623518,"ts":["UigGY7zyRphxNeq29WvYSn"],"sp":null,"ss":0,"xx":{"sn":{},"_t":"oo"},"md":null,"tt":"Two","ix":1}'),
];
const stopHistoryB = ({ one = {}, two = {} } = {}) => {
  const task = (p) => ({ t: 0, e: "Task6", p: { ...buildTaskCreate({ title: "Stop sample B", when: "anytime", project: B.project, now: 1794276500, timeZone: TZ }).p, ...p } });
  const item = (title, index, p) => ({ t: 0, e: "ChecklistItem3", p: { ...buildChecklistCreate({ title, task: B.template, index, now: 1794276500 }).p, ...p } });
  return [
    { [B.project]: { t: 0, e: "Task6", p: { ...buildTaskCreate({ title: "Samples B", type: 1, when: "anytime", now: 1794276400, timeZone: TZ }).p } } },
    { [B.tag]: { t: 0, e: "Tag4", p: { tt: "sample", sh: null, pn: [], ix: 0, xx: { sn: {}, _t: "oo" } } } },
    { [B.occurrence]: task({ st: 1, sr: S.nov9, tir: S.nov9, rt: [B.template] }) },
    {
      [B.template]: task({
        sr: null,
        st: 2,
        tir: S.nov10,
        icc: 1,
        icsd: S.nov10,
        nt: noteObject("Sample **notes**"),
        tg: [B.tag],
        rr: { of: [{ dy: 0 }], rrv: 4, tp: 0, ts: 0, fu: 16, ia: S.nov9, fa: 1, sr: S.nov9, rc: 0, ed: 64092211200 },
      }),
    },
    { [B.one]: item("One", 0, one) },
    { [B.two]: item("Two", 1, two) },
  ];
};

test("things_update_repeat stop: notes, tags, and checklist items go to the new to-do in one commit, exactly as sampled", async (t) => {
  at(t, 1794276623.623518);
  const { client, commits } = cloud(stopHistoryB());
  const result = await client.updateRepeat(B.template, { action: "stop" });
  assert.equal(commits.length, 1);
  const body = commits[0].body;
  const ids = Object.keys(body);
  const [newTodo, copy1, copy2] = ids;
  assert.deepEqual(ids.slice(3), [B.one, B.two, B.occurrence, B.template]);
  assert.equal(ids.length, 7);
  assert.equal(newTodo, result.newTodoId);
  const cd = ms(1794276623.623518);
  assert.deepEqual(body[newTodo], { t: 0, e: "Task6", p: { ...SAMPLED_STOP_B, cd } });
  assert.deepEqual(Object.keys(body[newTodo].p).sort(), Object.keys(SAMPLED_STOP_CREATE).sort());
  assert.equal(body[newTodo].p.nt.ch, 2335530048);
  assert.deepEqual(body[copy1], { t: 0, e: "ChecklistItem3", p: { ...SAMPLED_STOP_B_ITEMS[0], ts: [newTodo], cd } });
  assert.deepEqual(body[copy2], { t: 0, e: "ChecklistItem3", p: { ...SAMPLED_STOP_B_ITEMS[1], ts: [newTodo], cd } });
  assert.deepEqual(Object.keys(body[copy1].p), Object.keys(SAMPLED_STOP_B_ITEMS[0]));
  assert.deepEqual(body[B.one], { t: 2, e: "ChecklistItem3", p: {} });
  assert.deepEqual(body[B.two], { t: 2, e: "ChecklistItem3", p: {} });
  assert.deepEqual(body[B.occurrence], { t: 1, e: "Task6", p: { rt: [] } });
  assert.deepEqual(body[B.template], { t: 2, e: "Task6", p: {} });
  assert.deepEqual([result.checklistItemsCopied, result.scheduledDate, result.detachedOccurrences], [2, "2026-11-10", [B.occurrence]]);

  const db = await client.syncDatabase();
  const made = db.getTask(newTodo);
  assert.deepEqual([made.title, made.notes, made.when, made.projectId], ["Stop sample B", "Sample **notes**", "2026-11-10", B.project]);
  assert.deepEqual(db.resolveChecklistItems(newTodo).map((c) => [c.title, c.status]), [["One", "open"], ["Two", "open"]]);
  assert.deepEqual(db.checklistItemsFor(B.template), []);

  // Status and stop date are carried over, and ix counts from 0 in the template's order.
  const other = cloud(stopHistoryB({ one: { ix: 9 }, two: { ix: 4, ss: 3, sp: 1794270000 } }));
  await other.client.updateRepeat(B.occurrence, { action: "stop" });
  const [, first, second] = Object.values(other.commits[0].body);
  assert.deepEqual([first.p.tt, first.p.ix, first.p.ss, first.p.sp], ["Two", 0, 3, 1794270000]);
  assert.deepEqual([second.p.tt, second.p.ix, second.p.ss, second.p.sp], ["One", 1, 0, null]);
  assert.deepEqual([first.p.lt, first.p.md, first.p.cd], [true, null, cd]);

  // The validator accepts exactly this commit and refuses each near miss.
  const before = await cloud(stopHistoryB()).client.syncDatabase();
  assert.doesNotThrow(() => validateChangeMap(body, before));
  const withChange = (id, p) => ({ ...body, [id]: { ...body[id], p: { ...body[id].p, ...p } } });
  const without = (id) => Object.fromEntries(Object.entries(body).filter(([k]) => k !== id));
  const stopItem = /a checklist item created when a repeat is stopped needs lt true, md null, and the cd of the new to-do/;
  refused(withChange(copy1, { md: cd }), before, stopItem);
  refused(withChange(copy1, { lt: false }), before, stopItem);
  refused(withChange(copy1, { lt: false, md: cd }), before, stopItem);
  refused(withChange(copy2, { cd: cd + 1 }), before, stopItem);
  refused(withChange(copy2, { ts: [B.occurrence] }), before, stopItem);
  const templateItems = /must get the template's checklist items/;
  refused(without(copy2), before, templateItems);
  refused(withChange(copy2, { tt: "Three" }), before, templateItems);
  refused(withChange(copy2, { ix: 5 }), before, templateItems);
  refused(withChange(copy1, { ss: 3, sp: cd }), before, templateItems);
  refused({ ...body, [generateUUID()]: body[copy1] }, before, templateItems);
  refused(without(B.one), before, /parent task still references deleted item/);
  refused(withChange(newTodo, { nt: { ...SAMPLED_STOP_B.nt, ch: 0 } }), before, /is not the CRC-32 of the text/);
  refused(withChange(newTodo, { tg: [generateUUID()] }), before, /is not an existing tag/);
  // The shape belongs to a stop only: an ordinary new checklist item cannot have lt true or md null.
  const plain = buildChecklistCreate({ title: "step", task: B.occurrence, now: cd });
  assert.doesNotThrow(() => validateChangeMap({ [generateUUID()]: plain }, before));
  refused({ [generateUUID()]: { ...plain, p: { ...plain.p, md: null } } }, before, stopItem);
  refused({ [generateUUID()]: { ...plain, p: { ...plain.p, lt: true } } }, before, stopItem);
});

// --- hardening 2026-11-09: rebuild after a conflict, batch fields, closed projects, credentials, time zone ---

// A cloud whose first commit is answered 409 after `other` (a change map from another client) landed.
const conflictOnce = (items, other) =>
  cloud(items, {
    onCommit: (n, body, history) => {
      if (n !== 1) return undefined;
      history.push(typeof other === "function" ? other(body) : other);
      return new Response("conflict", { status: 409 });
    },
  });

test("adding or removing a tag after a conflict keeps the tag another client added in between", async () => {
  const [t, a, b, c] = [generateUUID(), generateUUID(), generateUUID(), generateUUID()];
  const items = [tag(a), tag(b), tag(c), todo(t, { tg: [a] })];
  const theirs = { [t]: { t: 1, e: "Task6", p: { tg: [a, b], md: 1794000000.5 } } };

  const add = conflictOnce(items, theirs);
  await add.client.addTagsToTask(t, [c]);
  assert.deepEqual(add.commits[0].body[t].p.tg, [a, c]); // built from the stale read
  assert.deepEqual(add.commits[1].body[t].p.tg, [a, b, c]); // rebuilt: b is kept
  assert.deepEqual((await add.client.syncDatabase()).tasks.get(t).tags, [a, b, c]);

  const remove = conflictOnce(items, theirs);
  await remove.client.removeTagsFromTask(t, [a]);
  assert.deepEqual(remove.commits[1].body[t].p.tg, [b]);

  // import_json add-tags and append-notes are the same read-modify-write.
  const imp = conflictOnce(items, { [t]: { t: 1, e: "Task6", p: { tg: [a, b], nt: noteObject("theirs. "), md: 1794000000.5 } } });
  await imp.client.importJson([{ type: "to-do", operation: "update", id: t, attributes: { "add-tags": [c], "append-notes": "ours" } }]);
  assert.deepEqual(imp.commits[1].body[t].p.tg, [a, b, c]);
  assert.equal(imp.commits[1].body[t].p.nt.v, "theirs. ours");
});

test("deleting a tag after a conflict also clears it from an item that got it in between", async () => {
  const [t1, t2, g] = [generateUUID(), generateUUID(), generateUUID()];
  const { client, commits } = conflictOnce([tag(g), todo(t1, { tg: [g] }), todo(t2)], { [t2]: { t: 1, e: "Task6", p: { tg: [g], md: 1794000000.5 } } });
  await client.deleteTag(g);
  assert.deepEqual(Object.keys(commits[0].body).sort(), [g, t1].sort());
  assert.deepEqual(Object.keys(commits[1].body).sort(), [g, t1, t2].sort());
  assert.deepEqual(commits[1].body[t2].p.tg, []);
  assert.deepEqual(commits[1].body[g], { t: 2, e: "Tag4", p: {} });
});

test("checklist items added after a conflict go after the item another client added, under the same new ids", async () => {
  const [t, c1, c2] = [generateUUID(), generateUUID(), generateUUID()];
  const theirs = { [c2]: { t: 0, e: "ChecklistItem3", p: { tt: "theirs", ts: [t], ss: 0, ix: 1 } } };
  const first = { [c1]: { t: 0, e: "ChecklistItem3", p: { tt: "first", ts: [t], ss: 0, ix: 0 } } };

  const add = conflictOnce([todo(t), first], theirs);
  const created = await add.client.addChecklistItems(t, ["x", "y"]);
  const ids = created.map((c) => c.id);
  assert.deepEqual(Object.keys(add.commits[0].body), ids);
  assert.deepEqual(Object.keys(add.commits[1].body), ids); // a retry never mints a second set
  assert.deepEqual(ids.map((id) => add.commits[0].body[id].p.ix), [1, 2]);
  assert.deepEqual(ids.map((id) => add.commits[1].body[id].p.ix), [2, 3]);

  // Replacing the checklist tombstones the item that arrived in between as well.
  const set = conflictOnce([todo(t), first], theirs);
  await set.client.setChecklist(t, ["only"]);
  assert.ok(!(c2 in set.commits[0].body));
  assert.deepEqual(set.commits[1].body[c2], { t: 2, e: "ChecklistItem3", p: {} });
  assert.deepEqual(set.commits[1].body[c1], { t: 2, e: "ChecklistItem3", p: {} });
});

test("closing a project after a conflict also closes a to-do another client added to it, and an import keeps its ids", async () => {
  const [p, t1, t2] = [generateUUID(), generateUUID(), generateUUID()];
  const { client, commits } = conflictOnce([project(p), todo(t1, { pr: [p] })], todo(t2, { pr: [p] }));
  const result = await client.updateProject(p, { status: "completed" });
  assert.deepEqual(Object.keys(commits[1].body).sort(), [p, t1, t2].sort());
  assert.equal(commits[1].body[t2].p.ss, 3);
  assert.equal(result.todosClosed, 2);

  const imp = conflictOnce([project(p)], todo(t1));
  const out = await imp.client.importJson([{ type: "to-do", attributes: { title: "new", list: p, "checklist-items": ["a", "b"] } }]);
  assert.deepEqual(Object.keys(imp.commits[1].body), Object.keys(imp.commits[0].body));
  assert.equal(Object.keys(imp.commits[1].body).length, 3);
  assert.equal(out.items[0].id, Object.keys(imp.commits[1].body)[0]);
});

test("emptying the Trash after a conflict leaves alone what was restored in between", async () => {
  const [t1, t2] = [generateUUID(), generateUUID()];
  const { client, commits } = conflictOnce([todo(t1, { tr: true }), todo(t2, { tr: true })], { [t2]: { t: 1, e: "Task6", p: { tr: false, md: 1794000000.5 } } });
  const result = await client.emptyTrash();
  assert.deepEqual(Object.keys(commits[0].body).sort(), [t1, t2].sort());
  assert.deepEqual(Object.keys(commits[1].body), [t1]);
  assert.equal(result.purgedCount, 1);
});

test("a batch field the operation does not use is an error that names it, with nothing written", async () => {
  const [t, p, a] = [generateUUID(), generateUUID(), generateUUID()];
  const { client, commits } = cloud([todo(t), project(p), area(a)]);
  const no = (promise, field) => assert.rejects(promise, (err) => err.message.includes(`does not use "${field}"`) && /Nothing was written/.test(err.message));
  await no(client.batchUpdateTodos([t], "complete", { when: "today" }), "when");
  await no(client.batchUpdateTodos([t], "complete", { deadline: "2027-01-05" }), "deadline");
  await no(client.batchUpdateTodos([t], "trash", { completion_date: "2026-08-25T12:00:00Z" }), "completion_date");
  await no(client.batchUpdateTodos([t], "reschedule", { when: "today", creationDate: "2026-08-25T12:00:00Z" }), "creation_date");
  await no(client.batchUpdateTodos([t], "set_dates", { deadline: "2027-01-05", when: "today" }), "when");
  await no(client.batchUpdateProjects([p], "complete", { area: a }), "area");
  await no(client.batchUpdateProjects([p], "trash", { deadline: "2027-01-05" }), "deadline");
  await no(client.batchUpdateProjects([p], "set_area", { area: a, when: "someday" }), "when");
  await no(client.batchUpdateProjects([p], "reschedule", { when: "someday", deadline: "2027-01-05" }), "deadline");
  await assert.rejects(client.batchUpdateTodos([t], "archive"), /Unknown to-do batch operation "archive"/);
  assert.equal(commits.length, 0);

  // Fields that belong to the operation are written; absent ones (undefined, null) are not an error.
  await client.batchUpdateTodos([t], "reschedule", { when: "someday", deadline: undefined, completionDate: null });
  await client.batchUpdateProjects([p], "set_area", { area: a });
  assert.equal(commits.length, 2);
  assert.equal(commits[0].body[t].p.st, 2);
  assert.deepEqual(commits[1].body[p].p.ar, [a]);
});

test("a new open to-do is not filed into a completed or canceled project; a finished one is", async () => {
  const [done, dropped, live, h, hLive] = [generateUUID(), generateUUID(), generateUUID(), generateUUID(), generateUUID()];
  const { client, commits } = cloud([
    project(done, { tt: "Old", ss: 3, sp: 1794000000 }),
    project(dropped, { tt: "Dropped", ss: 2, sp: 1794000000 }),
    project(live, { tt: "Live" }),
    heading(h, done, { tt: "Done part" }),
    heading(hLive, live, { tt: "Live part" }),
  ]);
  await assert.rejects(client.createTodo({ title: "x", project: done }), /project "Old" \(.+\) is completed, so a new open to-do cannot be filed into it/);
  await assert.rejects(client.createTodo({ title: "x", project: dropped }), /project "Dropped" \(.+\) is canceled/);
  await assert.rejects(client.createTodo({ title: "x", heading: h }), /is completed, so a new open to-do cannot be filed into it or under its headings/);
  await assert.rejects(client.importJson([{ type: "to-do", attributes: { title: "x", list: done } }]), /is completed/);
  assert.equal(commits.length, 0);

  await client.createTodo({ title: "finished there", project: done, completed: true, completionDate: "2026-08-25T12:00:00Z" });
  await client.createTodo({ title: "dropped there", heading: h, canceled: true });
  await client.createTodo({ title: "open in a live project", project: live });
  await client.createTodo({ title: "open under a live heading", heading: hLive });
  assert.equal(commits.length, 4);
  assert.equal(Object.values(commits[0].body)[0].p.ss, 3);
  assert.deepEqual(Object.values(commits[0].body)[0].p.pr, [done]);
});

test("stored credentials: HKDF round trip, and a record encrypted the old way is read and re-encrypted", async () => {
  const secret = "s3cret-key-that-is-longer-than-thirty-two-characters";
  const creds = { email: "a@b.c", password: "p\u00e4ss w\u00f6rd", historyKey: "KEY" };

  const sealed = await encryptJson(creds, secret);
  assert.deepEqual(await decryptJson(sealed, secret), creds);
  assert.deepEqual(await decryptJsonDetailed(sealed, secret), { data: creds, legacy: false });
  assert.notEqual(await encryptJson(creds, secret), sealed); // a fresh IV every time
  assert.ok(!sealed.includes("p\u00e4ss"));

  // The old key was the first 32 characters of the secret, so a secret sharing that prefix opened
  // old records. The derived key uses the whole secret.
  const samePrefix = secret.slice(0, 32) + "-but-different";
  const old = await encryptJsonLegacy(creds, secret);
  assert.deepEqual(await decryptJsonDetailed(old, secret), { data: creds, legacy: true });
  assert.deepEqual(await decryptJson(old, samePrefix), creds);
  await assert.rejects(decryptJson(sealed, samePrefix), /could not be decrypted/);
  await assert.rejects(decryptJson(sealed, "another secret"), (err) => !err.message.includes("KEY") && /re-authenticate/.test(err.message));
  await assert.rejects(encryptJson(creds, undefined), /DATA_ENCRYPTION_KEY is not set/);

  // The Durable Object record is rewritten under the derived key on its first read.
  const map = new Map([["credentials", old]]);
  const storage = { get: async (k) => map.get(k), put: async (k, v) => void map.set(k, v) };
  assert.deepEqual(await readStoredCredentials(storage, secret), creds);
  assert.notEqual(map.get("credentials"), old);
  assert.deepEqual(await decryptJsonDetailed(map.get("credentials"), secret), { data: creds, legacy: false });
  assert.equal(await readStoredCredentials({ get: async () => undefined }, secret), null);
});

test("a grant's props are upgraded when it gets a token: re-encrypted, and the second stored copy deleted", async () => {
  const secret = "another-long-secret-for-the-grant-props-test";
  const creds = { email: "a@b.c", password: "pw", historyKey: "KEY" };
  const cleared = [];
  const clear = async (id) => void cleared.push(id);

  const oldProps = { grantId: "g-1", email: "a@b.c", historyKey: "KEY", encryptedCredentials: await encryptJsonLegacy(creds, secret) };
  const next = await upgradeGrantProps(oldProps, secret, clear);
  assert.deepEqual(cleared, ["g-1"]);
  assert.ok(!("grantId" in next));
  assert.deepEqual(await decryptJsonDetailed(next.encryptedCredentials, secret), { data: creds, legacy: false });
  assert.equal(next.email, "a@b.c");

  assert.equal(await upgradeGrantProps(next, secret, clear), null); // already current: nothing to do
  assert.equal(await upgradeGrantProps({ grantId: "g-2" }, secret, clear), null); // the copy is the only one: kept
  assert.equal(await upgradeGrantProps({ grantId: "g-3", encryptedCredentials: await encryptJson({ email: "a@b.c" }, secret) }, secret, clear), null);
  assert.deepEqual(cleared, ["g-1"]);
});

test("sign-in checks the OAuth request before the password reaches Things Cloud, and stores credentials only in the grant", async (t) => {
  const secret = "sign-in-test-secret-that-is-long-enough-to-use";
  const realFetch = globalThis.fetch;
  const thingsCalls = [];
  globalThis.fetch = async (url) => {
    thingsCalls.push(String(url));
    return new Response(JSON.stringify({ email: "a@b.c", status: "SYAccountStatusActive", "history-key": "KEY" }));
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const kv = new Map();
  const completed = [];
  const env = {
    DATA_ENCRYPTION_KEY: secret,
    OAUTH_KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v), delete: async (k) => void kv.delete(k) },
    OAUTH_PROVIDER: {
      parseAuthRequest: async () => {
        throw new Error("Invalid client");
      },
      completeAuthorization: async (options) => {
        completed.push(options);
        return { redirectTo: "https://client.example/callback?code=abc" };
      },
    },
    // No OAUTH_CREDENTIALS binding: a write to the per-grant store would throw.
  };
  const post = (fields) =>
    ThingsHandler.request("/authorize/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }, env, { waitUntil() {}, passThroughOnException() {} });

  // No consent record and no valid authorization request: refused without asking Things Cloud.
  const refusedRes = await post({ email: "a@b.c", password: "guess", consentId: "nope", oauthParams: encodeURIComponent(JSON.stringify({ client_id: "x" })) });
  assert.equal(refusedRes.status, 400);
  assert.match(await refusedRes.text(), /Authorization request expired or invalid/);
  assert.equal(thingsCalls.length, 0);
  assert.equal(completed.length, 0);

  // A pending consent record: the password is checked, and the grant carries the only copy.
  kv.set("consent:c-1", JSON.stringify({ clientId: "client-1", scope: ["read", "write"] }));
  const okRes = await post({ email: "a@b.c", password: "right", consentId: "c-1" });
  assert.equal(okRes.status, 302);
  assert.equal(thingsCalls.length, 1);
  const { props, metadata } = completed[0];
  assert.ok(!("grantId" in props) && !("password" in props) && !("credentials" in props));
  assert.ok(!JSON.stringify({ props, metadata }).includes("right"));
  assert.deepEqual(await decryptJsonDetailed(props.encryptedCredentials, secret), { data: { email: "a@b.c", password: "right", historyKey: "KEY", mailDropEmail: null }, legacy: false });
});

test("date-dependent reads can be asked in another time zone; the database and writes keep the configured one", () => {
  const [east, west] = ["Pacific/Kiritimati", "Pacific/Pago_Pago"]; // UTC+14 and UTC-11: never the same calendar day
  const eastDay = localDate(east);
  const westDay = localDate(west);
  assert.equal(addDays(westDay, 1), eastDay);
  const now = Math.floor(Date.now() / 1000);
  const [start, due, finished] = [generateUUID(), generateUUID(), generateUUID()];
  const db = dbOf(
    todo(start, { tt: "starts on the eastern today", st: 1, sr: dateToTimestamp(eastDay), tir: dateToTimestamp(eastDay) }),
    todo(due, { tt: "due on the eastern today", st: 1, dd: dateToTimestamp(eastDay) }),
    todo(finished, { tt: "finished just now", ss: 3, sp: now })
  );
  const titles = (list) => list.map((x) => x.title);

  const inEast = db.inTimeZone(east);
  const inWest = db.inTimeZone(west);
  assert.deepEqual(titles(inEast.getToday()).sort(), ["due on the eastern today", "starts on the eastern today"]);
  assert.deepEqual(titles(inWest.getToday()), []);
  assert.deepEqual(titles(inWest.getUpcoming(3)).sort(), ["due on the eastern today", "starts on the eastern today"]);
  assert.deepEqual(titles(inEast.getUpcoming(3)), []);
  assert.deepEqual(titles(inEast.getDeadlines().dueToday), ["due on the eastern today"]);
  assert.deepEqual(titles(inWest.getDeadlines().dueSoon), ["due on the eastern today"]);
  assert.equal(inEast.getDailySummary().date, eastDay);
  assert.equal(inEast.getDailySummary().completedTodayCount, 1);
  assert.equal(inWest.getDailySummary().date, westDay);
  assert.deepEqual(titles(inEast.getLogbook({ since: eastDay, until: eastDay })), ["finished just now"]);
  assert.deepEqual(titles(inWest.getLogbook({ since: eastDay, until: eastDay })), []);
  assert.deepEqual(titles(inWest.getLogbook({ since: westDay, until: westDay })), ["finished just now"]);

  assert.equal(db.timeZone, TZ); // the shared database is not changed by a read in another zone
  assert.equal(db.today(), localDate(TZ));
  for (const bad of ["Mars/Olympus", "", "EST5", 5]) assert.throws(() => db.inTimeZone(bad), /is not a time zone this server knows/);

  // Only the five date-dependent read tools take the argument.
  const src = readFileSync(new URL("../src/things-mcp.js", import.meta.url), "utf8");
  assert.equal(src.match(/timezone: timezoneArg/g).length, 5);
  for (const tool of ["things_get_today", "things_get_upcoming", "things_get_logbook", "things_get_daily_summary", "things_get_deadlines"]) {
    const block = src.slice(src.indexOf(`"${tool}"`), src.indexOf("server.registerTool(", src.indexOf(`"${tool}"`)));
    assert.match(block, /timezone: timezoneArg/, tool);
    assert.match(block, /inZone\(db, timezone\)/, tool);
  }
  assert.match(src, /new ThingsCloudClient\(\{ \.\.\.creds, timeZone: this\.env\.USER_TIMEZONE \}\)/);
});

test("an import that creates a finished project creates its open to-dos with the project's status and stop date", async () => {
  const [old, existing] = [generateUUID(), generateUUID()];
  const { client, commits } = cloud([project(old, { tt: "Old", ss: 3, sp: 1794000000 }), todo(existing)]);
  const done = "2026-09-01T12:00:00Z";
  const doneTs = Date.parse(done) / 1000;
  const ownTs = Date.parse("2026-08-01T12:00:00Z") / 1000;
  const result = await client.importJson([
    {
      type: "project",
      attributes: {
        title: "Migrated",
        completed: true,
        "completion-date": done,
        items: [
          { type: "to-do", attributes: { title: "open" } },
          { type: "to-do", attributes: { title: "done earlier", completed: true, "completion-date": "2026-08-01T12:00:00Z" } },
          { type: "to-do", attributes: { title: "dropped", canceled: true, "completion-date": "2026-08-01T12:00:00Z" } },
          { type: "heading", attributes: { title: "Part" } },
          { type: "to-do", attributes: { title: "under heading", "checklist-items": ["step"] } },
        ],
      },
    },
    { type: "to-do", attributes: { title: "filed by title", list: "Migrated" } },
    { type: "to-do", attributes: { title: "elsewhere" } },
  ]);
  assert.equal(commits.length, 1);
  const byTitle = Object.fromEntries(Object.values(commits[0].body).map((c) => [c.p.tt, c]));
  const closed = ["open", "under heading", "filed by title"];
  for (const title of closed) {
    assert.equal(byTitle[title].p.ss, 3, title);
    assert.equal(byTitle[title].p.sp, doneTs, title);
  }
  assert.equal(byTitle.Migrated.p.sp, doneTs);
  assert.deepEqual([byTitle["done earlier"].p.ss, byTitle["done earlier"].p.sp], [3, ownTs]);
  assert.deepEqual([byTitle.dropped.p.ss, byTitle.dropped.p.sp], [2, ownTs]);
  assert.deepEqual([byTitle.Part.p.ss, byTitle.Part.p.sp], [0, null]);
  assert.deepEqual([byTitle.elsewhere.p.ss, byTitle.elsewhere.p.sp], [0, null]);
  assert.equal(byTitle.step.p.ss, 0);
  // A to-do closed with its project is written with the keys of a to-do created completed.
  assert.deepEqual(Object.keys(byTitle.open.p).sort(), Object.keys(byTitle["done earlier"].p).sort());
  assert.equal(result.todosClosedWithProject, 3);
  assert.equal(result.items[0].todosClosed, 3);
  assert.equal(result.todosCreated, 6);
  assert.ok(!("todosClosed" in result.items[1]));

  // A canceled project with no completion date: its to-dos are canceled with the project's own stop date.
  const out = await client.importJson([
    { type: "project", attributes: { title: "Dropped", canceled: true, items: [{ type: "to-do", attributes: { title: "a" } }, { type: "to-do", attributes: { title: "b", completed: true } }] } },
  ]);
  const second = Object.fromEntries(Object.values(commits[1].body).map((c) => [c.p.tt, c]));
  assert.equal(second.Dropped.p.ss, 2);
  assert.ok(second.Dropped.p.sp);
  assert.deepEqual([second.a.p.ss, second.a.p.sp], [2, second.Dropped.p.sp]);
  assert.equal(second.b.p.ss, 3);
  assert.equal(out.todosClosedWithProject, 1);
  assert.equal(out.items[0].todosClosed, 1);

  // An open project closes nothing, and a project that already existed closed still refuses.
  const open = await client.importJson([{ type: "project", attributes: { title: "Live", items: [{ type: "to-do", attributes: { title: "c" } }] } }]);
  assert.equal(open.todosClosedWithProject, 0);
  assert.ok(!("todosClosed" in open.items[0]));
  assert.equal(Object.values(commits[2].body).find((c) => c.p.tt === "c").p.ss, 0);
  await assert.rejects(client.importJson([{ type: "to-do", attributes: { title: "x", list: old } }]), /is completed, so a new open to-do cannot be filed into it/);
  assert.equal(commits.length, 3);
});
