// Things Cloud client and in-memory database.
//
// Wire format verified against Things 3.21 (Syncrony.framework decompilation) and a live
// history (schema 301): entities are versioned (Task6, Area3, Tag4, ChecklistItem3), property
// keys are short ("tt", "ss", "st", ...), calendar dates are unix timestamps at midnight UTC,
// relations are arrays of UUIDs, and a commit is a single POST whose body maps UUID -> change.

const THINGS_CLOUD_BASE = "https://cloud.culturedcode.com";
const SCHEMA_VERSION = 301;
const APP_ID = "com.culturedcode.ThingsMac";
const APP_INSTANCE_ID = "-things3-mcp-connector";
const PUSH_PRIORITY = 5;

const ENTITY = {
  task: "Task6",
  area: "Area3",
  tag: "Tag4",
  checklist: "ChecklistItem3",
};

// A cached database is trusted this long before asking Things Cloud for its head index again.
const CACHE_TTL_MS = 15000;
const DEFAULT_TIME_ZONE = "America/New_York";

// ---------------------------------------------------------------------------
// Dates, times, ids, checksums
// ---------------------------------------------------------------------------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDateString(value) {
  return typeof value === "string" && DATE_RE.test(value);
}

// "YYYY-MM-DD" -> unix seconds at midnight UTC (the form Things stores for sr, tir, dd).
export function dateToTimestamp(dateStr) {
  if (!dateStr) return null;
  const m = String(dateStr).match(DATE_RE);
  if (!m) throw new Error(`Invalid date "${dateStr}". Use YYYY-MM-DD.`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000;
}

// ISO 8601 string, Date, or unix timestamp -> unix seconds.
export function parseIsoDate(value) {
  if (value === null || value === undefined || value === "") return null;
  let seconds;
  if (typeof value === "number") seconds = value;
  else if (value instanceof Date) seconds = value.getTime() / 1000;
  else {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) throw new Error(`Invalid ISO 8601 date "${value}".`);
    seconds = ms / 1000;
  }
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 4102444800) {
    throw new Error(`Invalid date ${JSON.stringify(value)}: expected ISO 8601 or unix seconds, not milliseconds.`);
  }
  return seconds;
}

export function timestampToDate(ts) {
  if (ts === null || ts === undefined) return null;
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

// Calendar date in a time zone, as YYYY-MM-DD. Accepts a Date or unix seconds.
export function localDate(timeZone = DEFAULT_TIME_ZONE, when = new Date()) {
  const date = typeof when === "number" ? new Date(when * 1000) : when;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function addDays(dateStr, days) {
  return timestampToDate(dateToTimestamp(dateStr) + days * 86400);
}

// Reminder time is stored as seconds after midnight in the "ato" key.
export function timeToSeconds(timeStr) {
  if (timeStr === null || timeStr === undefined || timeStr === "") return null;
  if (typeof timeStr === "number") return timeStr;
  const m = String(timeStr).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
    throw new Error(`Invalid time "${timeStr}". Use HH:MM (24-hour).`);
  }
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0);
}

export function secondsToTime(seconds) {
  if (seconds === null || seconds === undefined) return null;
  const h = Math.floor(seconds / 3600);
  const mi = Math.floor((seconds % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

export function toUnixTimestamp(date = new Date()) {
  return date.getTime() / 1000;
}

// Things identifiers are a 16-byte UUID in Bitcoin-style base58: leading zero bytes become
// leading "1"s, so an id is usually 22 characters and sometimes 21. Things decodes every id into
// a 16-byte buffer and traps (crashing the Mac app's sync) when an id needs more bytes. Twenty-two
// random base58 characters overflow about 45% of the time, which is what broke sync on 2026-11-09.
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const THINGS_ID_BYTES = 16;

export function encodeBase58(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return "1".repeat(zeros) + out;
}

// Number of bytes an id decodes to, or -1 when it is not base58 at all.
export function base58ByteLength(id) {
  if (typeof id !== "string" || id.length === 0) return -1;
  let zeros = 0;
  while (zeros < id.length && id[zeros] === "1") zeros++;
  let n = 0n;
  for (const ch of id) {
    const digit = BASE58.indexOf(ch);
    if (digit < 0) return -1;
    n = n * 58n + BigInt(digit);
  }
  let bytes = 0;
  for (; n > 0n; n >>= 8n) bytes++;
  return zeros + bytes;
}

export function isThingsId(id) {
  return base58ByteLength(id) === THINGS_ID_BYTES;
}

export function generateUUID() {
  return encodeBase58(crypto.getRandomValues(new Uint8Array(THINGS_ID_BYTES)));
}

// Property keys that hold arrays of ids, and keys that hold unix-second timestamps.
const ID_LIST_KEYS = ["pr", "agr", "ar", "tg", "ts", "rt", "dl", "pn"];
const TIMESTAMP_KEYS = ["cd", "md", "sp", "lai"];
const CALENDAR_DATE_KEYS = ["sr", "tir", "dd", "icsd"];
const LATEST_TIMESTAMP = 4102444800; // 2100-01-01; anything later is milliseconds or garbage

// Entities and property keys the connector writes (Things 3.24.2 shapes). A key outside these is a
// typo or an unverified shape, so it is refused instead of sent. Creates must carry every key.
const ENTITY_KEYS = {
  Task: ["tt", "nt", "tp", "ss", "sp", "tr", "st", "sb", "sr", "tir", "ato", "dd", "pr", "agr", "ar", "tg", "ix", "ti", "cd", "md", "dds", "rt", "rmd", "dl", "icp", "do", "lai", "lt", "icc", "icsd", "rp", "acrd", "rr", "xx"],
  ChecklistItem: ["tt", "ss", "sp", "ix", "ts", "lt", "cd", "md", "xx"],
  Area: ["tt", "tg", "ix", "xx", "md"],
  Tag: ["tt", "sh", "pn", "ix", "xx", "md"],
};
const CREATE_OPTIONAL_KEYS = { Area: ["md"], Tag: ["md"] };
const KNOWN_ENTITY_NAMES = new Set(Object.values(ENTITY));
const entityFamily = (name) => String(name).replace(/\d+$/, "");

// A repeating template may only change these; scheduling and rule keys belong to the Things apps.
const TEMPLATE_SAFE_KEYS = new Set(["tt", "nt", "tg", "tr", "md", "pr", "agr", "ar", "ix"]);

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sameKeys = (o, keys) => isPlainObject(o) && Object.keys(o).length === keys.length && keys.every((k) => k in o);

// Things repeat rules (rr). Only the shapes Things 3.24.2 itself wrote are accepted (see
// things-reminders-sync docs/RECURRENCE.md); this is a port of its ThingsRepeat.problems(in:).
const RR_FAR_FUTURE = 64092211200;
const RR_KEYS = ["fu", "fa", "of", "tp", "ia", "sr", "rc", "ts", "rrv", "ed"];
const RR_UNITS = { 16: "daily", 256: "weekly", 8: "monthly", 4: "yearly" };
const rrMidnight = (v) => (isNum(v) && v >= 0 && v <= RR_FAR_FUTURE && v % 86400 === 0 ? v : null);
const inRange = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

export function repeatRuleProblems(rr) {
  if (!isPlainObject(rr)) return ["rr must be an object"];
  const out = [];
  const extra = Object.keys(rr).filter((k) => !RR_KEYS.includes(k));
  if (extra.length) out.push(`unknown keys ${JSON.stringify(extra.sort())}`);
  for (const key of RR_KEYS) if (key !== "ed" && !(key in rr)) out.push(`missing key ${key}`);
  if (out.length) return out;

  const freq = RR_UNITS[rr.fu];
  if (!Number.isInteger(rr.fu) || !freq) return ["fu must be 16, 256, 8, or 4"];
  if (!inRange(rr.fa, 1, 999)) out.push("fa must be an integer 1...999");
  if (rr.tp !== 0 && rr.tp !== 1) return [...out, "tp must be 0 or 1"];
  if (rr.rrv !== 4) out.push("rrv must be 4");
  if (rr.ts !== 0) out.push("ts must be 0");
  if (!Number.isInteger(rr.rc) || rr.rc < 0) return [...out, "rc must be an integer >= 0"];
  if (rrMidnight(rr.sr) === null || rr.sr <= 0) out.push("sr must be a midnight-UTC day");
  const ia = rrMidnight(rr.ia);
  if (rr.tp === 1) {
    if (ia !== 0) out.push("ia must be 0 for an after-completion rule");
  } else if (ia === null || ia <= 0) out.push("ia must be a midnight-UTC day");
  if (rr.rc > 0) {
    if ("ed" in rr) out.push("ed must be absent when rc > 0");
  } else if ("ed" in rr) {
    if (rr.ed !== RR_FAR_FUTURE && rrMidnight(rr.ed) === null) out.push("ed must be 64092211200 or a midnight-UTC day");
  } else out.push("ed is required when rc is 0");

  if (!Array.isArray(rr.of)) return [...out, "of must be an array"];
  if (rr.tp === 1) {
    if (rr.of.length) out.push("of must be empty for an after-completion rule");
  } else if (!rr.of.length) out.push("of must not be empty");
  else out.push(...offsetProblems(rr.of, freq));
  return out;
}

function offsetProblems(entries, freq) {
  const wdoOK = (v) => v === -1 || inRange(v, 1, 5);
  const wdOK = (v) => inRange(v, 0, 6);
  const moOK = (v) => inRange(v, 0, 11);
  const dyOK = (v) => v === -1 || inRange(v, 0, 30);
  const unique = (list) => new Set(list).size === list.length;
  const bad = ["of entry is not one of the observed shapes for this unit"];
  const ok = [];
  switch (freq) {
    case "daily":
      return entries.length === 1 && sameKeys(entries[0], ["dy"]) && entries[0].dy === 0 ? ok : bad;
    case "weekly": {
      const wds = entries.map((e) => (sameKeys(e, ["wd"]) ? e.wd : null));
      return wds.every(wdOK) && unique(wds) ? ok : bad;
    }
    case "monthly": {
      if (entries.length === 1 && sameKeys(entries[0], ["wdo", "wd"])) return wdoOK(entries[0].wdo) && wdOK(entries[0].wd) ? ok : bad;
      const dys = entries.map((e) => (sameKeys(e, ["dy"]) ? e.dy : null));
      return dys.every(dyOK) && unique(dys) ? ok : bad;
    }
    default: {
      if (entries.length !== 1) return bad;
      const e = entries[0];
      if (sameKeys(e, ["dy", "mo"])) return dyOK(e.dy) && moOK(e.mo) ? ok : bad;
      if (sameKeys(e, ["wdo", "mo", "wd"])) return wdoOK(e.wdo) && moOK(e.mo) && wdOK(e.wd) ? ok : bad;
      return bad;
    }
  }
}

const NOTE_KEYS = ["_t", "ch", "v", "t"];
const EMPTY_XX_KEYS = ["_t", "sn"];

function noteProblems(nt) {
  if (!sameKeys(nt, NOTE_KEYS)) return ["nt must be exactly {_t, ch, v, t}"];
  const out = [];
  if (nt._t !== "tx") out.push('nt._t must be "tx"');
  if (nt.t !== 1) out.push("nt.t must be 1 (a full note)");
  if (typeof nt.v !== "string") out.push("nt.v must be a string");
  else if (nt.ch !== crc32(nt.v)) out.push(`nt.ch ${JSON.stringify(nt.ch)} is not the CRC-32 of the text (${crc32(nt.v)})`);
  return out;
}

const xxOK = (xx) => sameKeys(xx, EMPTY_XX_KEYS) && xx._t === "oo" && isPlainObject(xx.sn) && !Object.keys(xx.sn).length;

// Throws before anything reaches Things Cloud if a change carries an id, date, shape, or reference
// that the Things apps cannot handle. Every write funnels through commitChanges, which calls this.
// Without `db` only the shape of each change is checked; with it, references must resolve to live
// entities of the right type (or be created in the same commit) and cross-field rules use the
// merged state of each touched entity.
export function validateChangeMap(body, db = null) {
  const problems = [];
  const entries = Object.entries(body);
  for (const [id, change] of entries) {
    const add = (msg) => problems.push(`${id}: ${msg}`);
    if (!isThingsId(id)) problems.push(`entity id "${id}" is not a Things id`);
    if (![0, 1, 2].includes(change?.t)) add(`change type ${change?.t} is not 0, 1, or 2`);
    if (!KNOWN_ENTITY_NAMES.has(change?.e)) {
      add(`entity "${change?.e}" is not one of ${[...KNOWN_ENTITY_NAMES].join(", ")}`);
      continue;
    }
    if (!isPlainObject(change.p)) {
      add("p must be an object");
      continue;
    }
    const p = change.p;
    const family = entityFamily(change.e);
    if (change.t === 2) {
      if (Object.keys(p).length) add("a delete must carry an empty p");
      continue;
    }
    const allowed = ENTITY_KEYS[family];
    for (const key of Object.keys(p)) {
      if (!allowed.includes(key)) add(`unknown ${change.e} key "${key}"`);
      else if (p[key] === undefined) add(`${key} is undefined and would be silently dropped`);
    }
    if (change.t === 0) {
      const optional = CREATE_OPTIONAL_KEYS[family] || [];
      for (const key of allowed) if (!(key in p) && !optional.includes(key)) add(`a create is missing ${key}`);
    }
    for (const key of ID_LIST_KEYS) {
      if (!(key in p)) continue;
      if (!Array.isArray(p[key])) add(`${key} must be an array of ids`);
      else for (const ref of p[key]) if (!isThingsId(ref)) add(`${key} reference "${ref}" is not a Things id`);
    }
    for (const key of [...TIMESTAMP_KEYS, ...CALENDAR_DATE_KEYS]) {
      const v = p[key];
      if (v === null || v === undefined) continue;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > LATEST_TIMESTAMP) {
        add(`${key} must be unix seconds, got ${JSON.stringify(v)}`);
      } else if (CALENDAR_DATE_KEYS.includes(key) && v % 86400 !== 0) {
        add(`${key} must be midnight UTC, got ${v}`);
      }
    }
    if ("tt" in p && typeof p.tt !== "string") add("tt must be a string");
    if ("xx" in p && !xxOK(p.xx)) add('xx must be {"_t":"oo","sn":{}}');
    if ("ix" in p && !isNum(p.ix)) add("ix must be a finite number");
    if ("ss" in p && ![0, 2, 3].includes(p.ss)) add("ss must be 0, 2, or 3");
    for (const key of ["lt", "tr"]) if (key in p && typeof p[key] !== "boolean") add(`${key} must be a boolean`);

    if (family === "Task") {
      // "No date" is null; 0 would be 1970-01-01.
      for (const key of ["sr", "tir", "dd", "sp", "icsd", "ato"]) {
        if (p[key] === 0) add(`${key} is 0; "no date" must be null`);
      }
      if ("ato" in p && p.ato !== null && !inRange(p.ato, 0, 86399)) add(`ato must be null or whole seconds after midnight, got ${JSON.stringify(p.ato)}`);
      if ("tp" in p && ![0, 1, 2].includes(p.tp)) add("tp must be 0, 1, or 2");
      if ("st" in p && ![0, 1, 2].includes(p.st)) add("st must be 0, 1, or 2");
      if ("sb" in p && ![0, 1].includes(p.sb)) add("sb must be 0 or 1");
      if ("nt" in p) for (const m of noteProblems(p.nt)) add(m);
      if ("icc" in p && p.icc !== null && !inRange(p.icc, 0, Number.MAX_SAFE_INTEGER)) add("icc must be an integer >= 0");
      if ("rr" in p && p.rr !== null) for (const m of repeatRuleProblems(p.rr)) add(`rr ${m}`);
      for (const key of ["pr", "agr", "ar"]) if (Array.isArray(p[key]) && p[key].length > 1) add(`${key} may hold at most one id`);
      if (typeof p.tt === "string" && typeof p.tt.isWellFormed === "function" && !p.tt.isWellFormed()) add("tt contains a lone surrogate");
    } else if (family === "ChecklistItem") {
      if ("ts" in p && !(Array.isArray(p.ts) && p.ts.length === 1)) add("a checklist item needs exactly one parent task in ts");
      if ("sp" in p && "ss" in p && (p.ss === 0) !== (p.sp === null)) add("sp must be null exactly when ss is 0");
      if ("nt" in p) add("a checklist item has no note");
    } else if (family === "Tag" && "sh" in p && p.sh !== null && typeof p.sh !== "string") add("sh must be a string or null");
    if ((family === "Area" || family === "Tag") && change.t === 0 && !p.tt) add("a new area or tag needs a title");
  }
  if (problems.length) throw new Error(`Refusing to write data Things cannot decode:\n- ${problems.slice(0, 20).join("\n- ")}`);
  if (db) validateAgainstDatabase(body, db);
}

// State-aware checks. `body` already passed the shape checks above.
function validateAgainstDatabase(body, db) {
  const problems = [];
  const shadow = db.clone();
  shadow.applyChangeMap(body);
  const todayTs = dateToTimestamp(db.today());
  const deleted = new Set();

  for (const [id, change] of Object.entries(body)) {
    const add = (msg) => problems.push(`${id}: ${msg}`);
    const p = change.p;
    const family = entityFamily(change.e);
    const existing = db.entityOf(id);
    if (change.t === 0 && existing) add("a create would overwrite an existing item");
    if (change.t !== 0 && !existing) add(`${change.t === 1 ? "update" : "delete"} of an item that does not exist`);
    if (existing && entityFamily(existing) !== family) add(`${change.e} does not match the existing ${existing}`);
    if (change.t === 2) {
      deleted.add(id);
      continue;
    }
    const taskOf = (ref) => shadow.tasks.get(ref);
    const refs = (key) => (Array.isArray(p[key]) ? p[key] : []);
    const refMust = (key, ok, what) => {
      for (const ref of refs(key)) if (!ok(ref)) add(`${key} reference ${ref} is not ${what}`);
    };

    if (family === "ChecklistItem") {
      refMust("ts", (r) => taskOf(r)?.type === 0 && !taskOf(r).trashed, "an existing, untrashed to-do");
      continue;
    }
    refMust("tg", (r) => shadow.tags.has(r), "an existing tag");
    if (family === "Area") continue;
    if (family === "Tag") {
      refMust("pn", (r) => r !== id && shadow.tags.has(r), "an existing tag other than itself");
      continue;
    }

    // Tasks, projects, and headings.
    const t = shadow.tasks.get(id);
    const before = db.tasks.get(id);
    refMust("pr", (r) => taskOf(r)?.type === 1 && !taskOf(r).trashed, "an existing, untrashed project");
    refMust("agr", (r) => taskOf(r)?.type === 2 && !taskOf(r).trashed, "an existing, untrashed heading");
    refMust("ar", (r) => shadow.areas.has(r), "an existing area");
    refMust("rt", (r) => Boolean(taskOf(r)?.recurrenceRule), "an existing repeating template");

    if (change.t === 1 && before?.recurrenceRule) {
      for (const key of Object.keys(p)) if (!TEMPLATE_SAFE_KEYS.has(key)) add(`${key} would change a repeating template; edit repeating to-dos in Things`);
    }
    if (change.t === 1 && before?.repeatingTemplates?.length) {
      for (const key of ["rr", "rt", "tp"]) if (key in p) add(`${key} would change a repeating occurrence; edit repeating to-dos in Things`);
    }

    if (["pr", "agr", "ar", "tp"].some((k) => k in p) || change.t === 0) {
      const heading = t.heading ? taskOf(t.heading) : null;
      if (t.type === 0) {
        if (t.area && (t.project || t.heading)) add("a to-do cannot be in both an area and a project");
        if (heading && !heading.project) add(`heading ${t.heading} does not belong to a project`);
        if (heading && t.project && heading.project !== t.project) add(`heading ${t.heading} belongs to project ${heading.project}, not ${t.project}`);
      } else if (t.type === 1 && (t.project || t.heading)) add("a project cannot be inside a project or heading");
      else if (t.type === 2 && (t.area || t.heading || !t.project)) add("a heading belongs to exactly one project and nothing else");
    }

    if (["st", "sr", "tp"].some((k) => k in p) && !t.recurrenceRule && typeof t.start === "number") {
      const sr = t.startDate ? dateToTimestamp(t.startDate) : null;
      if (t.type === 2 && t.start !== 1) add("a heading must have st 1");
      if (sr !== null && sr > todayTs && t.start !== 2) add(`start date ${t.startDate} is in the future, so st must be 2 (got ${t.start})`);
      if (sr !== null && sr <= todayTs && t.start === 2) add(`st 2 (someday) with start date ${t.startDate}, which is today or past, is inconsistent`);
      if (t.start === 0 && sr !== null) add("an Inbox to-do (st 0) cannot have a start date");
    }
    if ("ato" in p && t.reminderSeconds !== null && t.reminderSeconds !== undefined && !t.startDate && !t.recurrenceRule) {
      add("a reminder time needs a start date");
    }
    if (["st", "pr", "agr", "ar", "tp"].some((k) => k in p) && t.type === 0 && t.start === 0 && (t.project || t.heading || t.area)) {
      add("a to-do in a project, heading, or area cannot be in the Inbox (st 0)");
    }
    if (("ss" in p || "sp" in p) && t.type !== undefined) {
      const open = t.status === 0 || t.status === undefined;
      if (open && t.stopDate) add("an open item cannot have a stop date (sp)");
      if (!open && !t.stopDate) add("a completed or canceled item needs a stop date (sp)");
    }
  }

  // Deleting something that live items still point at leaves dangling references.
  if (deleted.size) {
    const dangling = (owner, what, list) => {
      for (const ref of list || []) if (deleted.has(ref)) problems.push(`${owner}: ${what} still references deleted item ${ref}`);
    };
    for (const t of shadow.tasks.values()) {
      dangling(t.uuid, "project", [t.project]);
      dangling(t.uuid, "heading", [t.heading]);
      dangling(t.uuid, "area", [t.area]);
      dangling(t.uuid, "tag list", t.tags);
      dangling(t.uuid, "repeat template", t.repeatingTemplates);
    }
    for (const c of shadow.checklists.values()) dangling(c.uuid, "parent task", [c.task]);
    for (const a of shadow.areas.values()) dangling(a.uuid, "tag list", a.tags);
    for (const g of shadow.tags.values()) dangling(g.uuid, "parent tag", [g.parent]);
  }

  if (problems.length) throw new Error(`Refusing to write data Things cannot handle:\n- ${problems.slice(0, 20).join("\n- ")}`);
}

// CRC-32 of the UTF-8 text; Things stores it as "ch" on note objects.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(text) {
  const bytes = new TextEncoder().encode(text);
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function noteObject(text) {
  const v = text || "";
  return { _t: "tx", t: 1, ch: v ? crc32(v) : 0, v };
}

function applyNotePatches(text, patches) {
  let out = text || "";
  for (const patch of patches) {
    const start = patch.p || 0;
    out = out.slice(0, start) + (patch.r || "") + out.slice(start + (patch.l || 0));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Change builders (the wire format lives here and only here)
// ---------------------------------------------------------------------------

// Resolve a "when" value into the scheduling fields: st (0 inbox, 1 anytime, 2 someday),
// sb (1 = this evening), sr (scheduled date) and tir (today index reference date).
export function schedulingFields(when, timeZone) {
  const today = localDate(timeZone);
  const clear = { st: 1, sb: 0, sr: null, tir: null };
  switch (when) {
    case "inbox":
      return { st: 0, sb: 0, sr: null, tir: null };
    case "anytime":
      return clear;
    case "someday":
      return { st: 2, sb: 0, sr: null, tir: null };
    case "today":
      return { st: 1, sb: 0, sr: dateToTimestamp(today), tir: dateToTimestamp(today) };
    case "tomorrow": {
      const tomorrow = addDays(today, 1);
      const ts = dateToTimestamp(tomorrow);
      return { st: 2, sb: 0, sr: ts, tir: ts };
    }
    case "evening":
      return { st: 1, sb: 1, sr: dateToTimestamp(today), tir: dateToTimestamp(today) };
    default: {
      if (!isDateString(when)) {
        throw new Error(`Invalid "when" value "${when}". Use inbox, today, tomorrow, evening, anytime, someday, or YYYY-MM-DD.`);
      }
      const ts = dateToTimestamp(when);
      // A date in the future is "Upcoming" (start = someday + scheduled date); today or earlier is Today.
      return { st: when > today ? 2 : 1, sb: 0, sr: ts, tir: ts };
    }
  }
}

// A reminder needs a date; with no scheduled date it is attached to today.
function withReminder(fields, reminderTime, timeZone) {
  const ato = timeToSeconds(reminderTime);
  if (ato === null) return { ...fields, ato: null };
  if (fields.sr === null || fields.sr === undefined) {
    const today = dateToTimestamp(localDate(timeZone));
    return { ...fields, st: 1, sr: today, tir: today, ato };
  }
  return { ...fields, ato };
}

const EMPTY_XX = () => ({ sn: {}, _t: "oo" });

export function buildTaskCreate({
  title,
  notes = "",
  type = 0,
  when = "inbox",
  reminderTime = null,
  deadline = null,
  project = null,
  heading = null,
  area = null,
  tags = [],
  status = 0,
  creationDate = null,
  completionDate = null,
  now = toUnixTimestamp(),
  timeZone,
}) {
  const sched = withReminder(schedulingFields(when, timeZone), reminderTime, timeZone);

  let ss = 0;
  if (typeof status === "number") ss = status;
  else if (status === "completed") ss = 3;
  else if (status === "canceled") ss = 2;

  let cd = now;
  if (creationDate !== null && creationDate !== undefined) {
    const parsedCd = parseIsoDate(creationDate);
    if (parsedCd <= now) cd = parsedCd;
  }

  let sp = null;
  if (ss === 3 || ss === 2) {
    sp = now;
    if (completionDate !== null && completionDate !== undefined) {
      const parsedComp = parseIsoDate(completionDate);
      if (parsedComp <= now) sp = parsedComp;
    }
  }

  return {
    t: 0,
    e: ENTITY.task,
    p: {
      tt: title,
      nt: noteObject(notes),
      tp: type,
      ss,
      sp,
      tr: false,
      st: sched.st,
      sb: sched.sb,
      sr: sched.sr,
      tir: sched.tir,
      ato: sched.ato ?? null,
      dd: deadline ? dateToTimestamp(deadline) : null,
      // A to-do inside a heading belongs to the project through that heading.
      pr: heading ? [] : project ? [project] : [],
      agr: heading ? [heading] : [],
      ar: project || heading ? [] : area ? [area] : [],
      tg: tags,
      ix: 0,
      ti: 0,
      cd,
      md: now,
      // Defaults Things writes on every new task.
      dds: null,
      rt: [],
      rmd: null,
      dl: [],
      icp: false,
      do: 0,
      lai: null,
      lt: false,
      icc: 0,
      icsd: null,
      rp: null,
      acrd: null,
      rr: null,
      xx: EMPTY_XX(),
    },
  };
}

export function buildChecklistCreate({ title, task, index = 0, status = 0, now = toUnixTimestamp() }) {
  return {
    t: 0,
    e: ENTITY.checklist,
    p: {
      tt: title,
      ss: status,
      sp: status === 0 ? null : now,
      ts: [task],
      ix: index,
      cd: now,
      md: now,
      lt: false,
      xx: EMPTY_XX(),
    },
  };
}

function statusFields(status, now) {
  if (status === "completed") return { ss: 3, sp: now };
  if (status === "canceled") return { ss: 2, sp: now };
  if (status === "open") return { ss: 0, sp: null };
  return {};
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class ThingsCloudClient {
  constructor({ email, password, historyKey = null, timeZone = DEFAULT_TIME_ZONE, fetchImpl = null }) {
    this.email = email.trim().toLowerCase();
    this.password = password;
    this.historyKey = historyKey;
    this.timeZone = timeZone || DEFAULT_TIME_ZONE;
    this.fetch = fetchImpl || ((...args) => fetch(...args));
    this._db = null;
    this._dbCheckedAt = 0;
  }

  static encodePassword(rawPassword) {
    return encodeURIComponent(rawPassword).replace(
      /[!*'();:@&=+$,/?%#\[\]]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
    );
  }

  static commonHeaders(password) {
    return {
      "Content-Type": "application/json; charset=UTF-8",
      "Content-Encoding": "UTF-8",
      Accept: "application/json",
      "User-Agent": "ThingsMac/3.21.3",
      "things-client-info": JSON.stringify({
        nativeAppVersion: "3.21.3",
        preferredLanguage: "en",
        uiWritingDirection: "LTR",
      }),
      Authorization: `Password ${ThingsCloudClient.encodePassword(password)}`,
    };
  }

  // fetch with a bounded retry on 429 (honouring Retry-After).
  async request(url, init = {}, { retries = 2 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(url, {
        ...init,
        headers: { ...ThingsCloudClient.commonHeaders(this.password), ...(init.headers || {}) },
      });
      if (res.status !== 429 || attempt >= retries) return res;
      const retryAfter = Number(res.headers.get("Retry-After"));
      const waitMs = Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500 * (attempt + 1), 6000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  async validateAndFetchAccount() {
    const url = `${THINGS_CLOUD_BASE}/version/1/account/${encodeURIComponent(this.email)}`;
    const response = await this.request(url, { method: "GET" });

    if (response.status === 401) throw new Error("Invalid Things Cloud password.");
    if (response.status === 404) throw new Error("Things Cloud account not found for this email.");
    if (!response.ok) {
      throw new Error(`Things Cloud error (${response.status}): ${await response.text()}`);
    }

    const data = await response.json();
    this.historyKey = data["history-key"];
    return {
      email: data.email,
      status: data.status,
      historyKey: data["history-key"],
      mailDropEmail: data["maildrop-email"] || null,
      slaVersionAccepted: data["SLA-version-accepted"],
      issues: data.issues || [],
    };
  }

  async getMaildropEmail() {
    return (await this.validateAndFetchAccount()).mailDropEmail;
  }

  async resetMaildropEmail() {
    const url = `${THINGS_CLOUD_BASE}/version/1/account/${encodeURIComponent(this.email)}/maildrop`;
    const response = await this.request(url, { method: "POST" });
    if (!response.ok) throw new Error(`Failed to reset maildrop: ${response.status} ${await response.text()}`);
    return (await response.json())["maildrop-email"] || null;
  }

  async clearMaildropEmail() {
    const url = `${THINGS_CLOUD_BASE}/version/1/account/${encodeURIComponent(this.email)}/maildrop`;
    const response = await this.request(url, { method: "DELETE" });
    if (!response.ok) throw new Error(`Failed to clear maildrop: ${response.status} ${await response.text()}`);
    return true;
  }

  async ensureHistoryKey() {
    if (!this.historyKey) await this.validateAndFetchAccount();
    return this.historyKey;
  }

  async getHistoryMetadata() {
    await this.ensureHistoryKey();
    const response = await this.request(`${THINGS_CLOUD_BASE}/version/1/history/${this.historyKey}`, { method: "GET" });
    if (!response.ok) throw new Error(`Failed to fetch history metadata: ${response.status}`);
    const data = await response.json();
    // A missing or malformed head must not read as "empty history": that would wipe the cache.
    const head = data?.["latest-server-index"];
    if (!Number.isInteger(head) || head < 0) {
      throw new Error(`History metadata has no valid latest-server-index (got ${JSON.stringify(head)}); refusing to treat it as empty.`);
    }
    return {
      historyKey: this.historyKey,
      latestServerIndex: head,
      latestSchemaVersion: data["latest-schema-version"] || SCHEMA_VERSION,
    };
  }

  async pullItems(startIndex = 0) {
    await this.ensureHistoryKey();
    const url = `${THINGS_CLOUD_BASE}/version/1/history/${this.historyKey}/items?start-index=${startIndex}`;
    const response = await this.request(url, { method: "GET" });
    if (!response.ok) throw new Error(`Failed to pull history items: ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data?.items) || !data.items.every(isPlainObject)) {
      throw new Error(`History page at index ${startIndex} is malformed (items is not a list of change maps).`);
    }
    return {
      schema: data.schema,
      currentItemIndex: data["current-item-index"] || 0,
      items: data.items,
    };
  }

  // Every change map from `start` up to the server head, in order. current-item-index is the server
  // head, not the end of a page: a long history comes back in capped pages, so advance by the
  // number of items received. A page with no items before the head fails closed instead of ending
  // the sync, which would mark data as read that never arrived.
  async pullRange(start, head) {
    const all = [];
    while (start < head) {
      const page = await this.pullItems(start);
      if (page.items.length === 0) {
        throw new Error(`History page at index ${start} was empty although the server head is ${head}; sync aborted.`);
      }
      all.push(...page.items);
      start += page.items.length;
    }
    return all;
  }

  // Cached database. Within CACHE_TTL_MS it costs no requests; after that it asks for the head
  // index (one request) and pulls only items added since the last sync. New items are applied to
  // a copy that replaces the cache only when the whole pull succeeded.
  async syncDatabase({ force = false } = {}) {
    if (!force && this._db && Date.now() - this._dbCheckedAt < CACHE_TTL_MS) return this._db;

    const meta = await this.getHistoryMetadata();
    let base = this._db;
    if (base && meta.latestServerIndex < base.latestServerIndex) {
      // The head went backwards. A real history reset is rebuilt from scratch below; a head of 0
      // after we held data is far more likely a bad response, so fail closed.
      if (meta.latestServerIndex === 0) throw new Error("History head is 0 although a synced history was cached; refusing to discard it.");
      base = null;
    }
    const db = base ? base.clone() : new ThingsDatabase(this.timeZone);

    const itemMaps = await this.pullRange(db.latestServerIndex, meta.latestServerIndex);
    for (const itemMap of itemMaps) db.applyChangeMap(itemMap);
    db.latestServerIndex = Math.max(db.latestServerIndex + itemMaps.length, meta.latestServerIndex);

    this._db = db;
    this._dbCheckedAt = Date.now();
    return db;
  }

  invalidateCache() {
    this._dbCheckedAt = 0;
  }

  // Did a commit whose outcome we never saw (5xx, dropped connection) land? Reads the history
  // after `ancestor` and looks for every key of the body with the same change type. Returns true,
  // false, or null when the history cannot be read either.
  async commitLanded(body, ancestor) {
    try {
      const head = (await this.getHistoryMetadata()).latestServerIndex;
      const seen = new Set();
      for (const itemMap of await this.pullRange(ancestor, head)) {
        for (const [id, ch] of Object.entries(body)) if (itemMap[id]?.t === ch.t) seen.add(id);
      }
      return seen.size === Object.keys(body).length;
    } catch {
      return null;
    }
  }

  // Things Cloud takes the changes inside the commit request itself: one POST whose body maps
  // each UUID to its change. (The separate /stage endpoint is only for oversized objects.)
  // The body, and so every minted id, is built once: every retry resends the same ids, and a
  // commit of unknown outcome is checked against the history before anything is resent, so a
  // retry cannot duplicate a create. All changes in one call land together or not at all.
  async commitChanges(changes) {
    const body = {};
    for (const change of changes) Object.assign(body, change);
    if (!Object.keys(body).length) return { serverHeadIndex: null };

    await this.ensureHistoryKey();
    let db = await this.syncDatabase();
    validateChangeMap(body, db);
    const payload = JSON.stringify(body);
    let ancestor = db.latestServerIndex;

    // After a 409/412 or a verified miss, re-read the head and re-validate against the fresh state.
    const refresh = async () => {
      this.invalidateCache();
      db = await this.syncDatabase({ force: true });
      validateChangeMap(body, db);
      ancestor = db.latestServerIndex;
    };

    for (let attempt = 0; ; attempt++) {
      const url = `${THINGS_CLOUD_BASE}/version/1/history/${this.historyKey}/commit?ancestor-index=${ancestor}&_cnt=1`;
      let res = null;
      let netError = null;
      try {
        res = await this.request(url, {
          method: "POST",
          headers: {
            Schema: String(SCHEMA_VERSION),
            "App-Id": APP_ID,
            "App-Instance-Id": APP_INSTANCE_ID,
            "Push-Priority": String(PUSH_PRIORITY),
          },
          body: payload,
        });
      } catch (err) {
        netError = err;
      }

      if (res?.ok) {
        const data = await res.json().catch(() => ({}));
        const head = data["server-head-index"] ?? null;
        if (this._db && head === ancestor + 1 && this._db.latestServerIndex === ancestor) {
          // Only our commit landed since the last sync: apply it locally instead of re-pulling.
          const next = this._db.clone();
          next.applyChangeMap(JSON.parse(payload));
          next.latestServerIndex = head;
          this._db = next;
          this._dbCheckedAt = Date.now();
        } else {
          this.invalidateCache();
        }
        return { serverHeadIndex: head };
      }

      // The index was stale (another client committed): nothing was written. Retry with the real head.
      if (res && (res.status === 409 || res.status === 412) && attempt < 2) {
        await refresh();
        continue;
      }

      // 5xx or a dropped connection: the commit may or may not have been applied. Check before resending.
      if (!res || res.status >= 500) {
        const detail = res ? `${res.status} ${await res.text().catch(() => "")}` : `network error: ${netError?.message}`;
        const landed = await this.commitLanded(body, ancestor);
        this.invalidateCache();
        if (landed === true) return { serverHeadIndex: null, recoveredAfterError: detail };
        if (landed === false && attempt < 2) {
          await refresh();
          continue;
        }
        throw new Error(
          landed === false
            ? `Commit failed (${detail}); the history shows it was NOT applied.`
            : `Commit failed (${detail}) and the history could not be read to check: the changes MAY have been applied. Re-read Things before retrying.`
        );
      }

      this.invalidateCache();
      throw new Error(`Commit failed (${res.status}); nothing was written. ${await res.text().catch(() => "")}`.trim());
    }
  }

  // Backwards-compatible name used by older callers.
  async stageAndCommitChanges(changes) {
    return this.commitChanges(changes);
  }

  // --- Reference resolution -------------------------------------------------

  resolveTagIds(db, tags = []) {
    return [...new Set(tags.map((tag) => db.resolveRef("tag", tag)))];
  }

  // --- To-dos ---------------------------------------------------------------

  async createTodo({
    title,
    notes = "",
    when = undefined,
    reminderTime = null,
    deadline = null,
    project = null,
    heading = null,
    area = null,
    tags = [],
    checklist = [],
    status = 0,
    completed = undefined,
    canceled = undefined,
    completionDate = null,
    creationDate = null,
  }) {
    const db = await this.syncDatabase();
    const taskUUID = generateUUID();
    const now = toUnixTimestamp();
    // A to-do in a project, heading, or area cannot sit in the Inbox; default to Anytime there.
    if (when === undefined || when === null) when = project || heading || area ? "anytime" : "inbox";

    let ss = status;
    if (completed === true) ss = 3;
    else if (canceled === true) ss = 2;

    const change = buildTaskCreate({
      title,
      notes,
      when,
      reminderTime,
      deadline,
      project: project ? db.resolveRef("project", project) : null,
      heading: heading ? db.resolveRef("heading", heading) : null,
      area: area ? db.resolveRef("area", area) : null,
      tags: this.resolveTagIds(db, tags),
      status: ss,
      completionDate,
      creationDate,
      now,
      timeZone: this.timeZone,
    });
    const changes = [{ [taskUUID]: change }];

    (checklist || []).forEach((item, idx) => {
      changes.push({
        [generateUUID()]: buildChecklistCreate({
          title: typeof item === "string" ? item : item.title,
          task: taskUUID,
          index: idx,
          now,
        }),
      });
    });

    await this.commitChanges(changes);
    return {
      id: taskUUID,
      title,
      when,
      status: "open",
      deadline: deadline || null,
      reminderTime: reminderTime || null,
    };
  }

  // Build the property patch for an update. Throws on unknown references or bad dates.
  buildTaskPatch(db, updates, now = toUnixTimestamp()) {
    const existing = updates.__uuid ? db.tasks.get(updates.__uuid) : null;
    let statusArg = updates.status;
    if (updates.completed === true) statusArg = "completed";
    else if (updates.canceled === true) statusArg = "canceled";
    else if (updates.completed === false && statusArg === undefined && existing?.status === 3) statusArg = "open";
    else if (updates.canceled === false && statusArg === undefined && existing?.status === 2) statusArg = "open";

    const p = { md: now, ...statusFields(statusArg, now) };

    if (updates.title !== undefined) p.tt = updates.title;
    if (updates.notes !== undefined) p.nt = noteObject(updates.notes);
    else if (updates["append-notes"] || updates.appendNotes || updates["prepend-notes"] || updates.prependNotes) {
      let baseNotes = existing?.notes || "";
      const prepend = updates["prepend-notes"] ?? updates.prependNotes;
      const append = updates["append-notes"] ?? updates.appendNotes;
      if (prepend) baseNotes = prepend + baseNotes;
      if (append) baseNotes = baseNotes + append;
      p.nt = noteObject(baseNotes);
    }

    if (updates.when !== undefined) Object.assign(p, withReminder(schedulingFields(updates.when, this.timeZone), null, this.timeZone), { ato: undefined });
    if (updates.when !== undefined && p.ato === undefined) delete p.ato;

    if (updates.reminderTime !== undefined) {
      const existingSr = p.sr !== undefined ? p.sr : existing?.startDate ? dateToTimestamp(existing.startDate) : null;
      Object.assign(p, withReminder({ st: p.st ?? 1, sb: p.sb ?? 0, sr: existingSr, tir: p.tir ?? null }, updates.reminderTime, this.timeZone));
      if (updates.reminderTime) {
        if (p.st === undefined) delete p.st;
      }
      if (updates.when === undefined) {
        if (existingSr === null && updates.reminderTime) {
          // sr/tir/st were set by withReminder
        } else {
          delete p.sr;
          delete p.tir;
          delete p.st;
          delete p.sb;
        }
      }
    }

    if (updates.deadline !== undefined) p.dd = updates.deadline ? dateToTimestamp(updates.deadline) : null;

    // Creation date: cannot be in the future
    const rawCd = updates.creationDate ?? updates.creation_date ?? updates["creation-date"];
    if (rawCd !== undefined && rawCd !== null) {
      const cdTs = parseIsoDate(rawCd);
      if (cdTs <= now) {
        p.cd = cdTs;
      }
    }

    // Completion date: only applies to completed or canceled items; cannot be in the future
    const rawComp = updates.completionDate ?? updates.completion_date ?? updates["completion-date"];
    if (rawComp !== undefined && rawComp !== null) {
      const effectiveSs = p.ss !== undefined ? p.ss : existing?.status;
      if (effectiveSs === 3 || effectiveSs === 2) {
        const compTs = parseIsoDate(rawComp);
        if (compTs <= now) {
          p.sp = compTs;
        }
      } else {
        p.sp = null;
      }
    }

    // Containers: null or "" clears; a heading implies its project.
    if (updates.heading !== undefined || updates["heading-id"] !== undefined) {
      const headingRef = updates.heading ?? updates["heading-id"];
      if (headingRef) {
        p.agr = [db.resolveRef("heading", headingRef)];
        p.pr = [];
        p.ar = [];
      } else {
        p.agr = [];
      }
    }
    if (updates.project !== undefined) {
      p.pr = updates.project ? [db.resolveRef("project", updates.project)] : [];
      p.agr = [];
      if (updates.project) p.ar = [];
    }
    if (updates.list !== undefined || updates["list-id"] !== undefined) {
      const listRef = updates.list ?? updates["list-id"];
      if (listRef) {
        const resolved = db.resolveListRef(listRef);
        if (resolved.type === "project") {
          p.pr = [resolved.id];
          p.agr = [];
          p.ar = [];
        } else {
          p.ar = [resolved.id];
          p.pr = [];
          p.agr = [];
        }
      } else {
        p.pr = [];
        p.ar = [];
        p.agr = [];
      }
    }
    if (updates.area !== undefined || updates["area-id"] !== undefined) {
      const areaRef = updates.area ?? updates["area-id"];
      p.ar = areaRef ? [db.resolveRef("area", areaRef)] : [];
      if (areaRef) {
        p.pr = [];
        p.agr = [];
      }
    }
    if (updates.tags !== undefined) p.tg = this.resolveTagIds(db, updates.tags);
    if (updates.trashed !== undefined) p.tr = Boolean(updates.trashed);
    if (updates.type !== undefined) p.tp = updates.type;

    // Moving an Inbox to-do into a project, heading, or area takes it out of the Inbox.
    const movedIn = [p.pr, p.agr, p.ar].some((ids) => ids && ids.length);
    if (movedIn && p.st === undefined && existing?.type === 0 && existing.start === 0) Object.assign(p, { st: 1, sb: 0 });

    return p;
  }

  async updateTodo(uuid, updates = {}) {
    const db = await this.syncDatabase();
    if (!db.tasks.has(uuid)) throw new Error(`No to-do, project, or heading with id ${uuid}.`);
    const patch = this.buildTaskPatch(db, { ...updates, __uuid: uuid });
    await this.commitChanges([{ [uuid]: { t: 1, e: ENTITY.task, p: patch } }]);
    return { id: uuid, updated: true };
  }

  async trashTodo(uuid) {
    return this.updateTodo(uuid, { trashed: true });
  }

  // Tombstones for `ids` plus everything that would otherwise be left pointing at them: checklist
  // items, headings, and trashed children of a purged project or heading, and tag or area
  // references on items that stay. Live children of a purged project are left alone; the
  // validator then refuses the commit and names them.
  purgeChanges(db, ids) {
    const purge = new Set(ids);
    const now = toUnixTimestamp();
    for (let grew = true; grew; ) {
      grew = false;
      for (const t of db.tasks.values()) {
        if (purge.has(t.uuid) || !(purge.has(t.project) || purge.has(t.heading))) continue;
        if (t.type === 2 || t.trashed) {
          purge.add(t.uuid);
          grew = true;
        }
      }
    }
    for (const c of db.checklists.values()) if (purge.has(c.task)) purge.add(c.uuid);

    const changes = [...purge].map((id) => ({ [id]: { t: 2, e: db.entityOf(id), p: {} } }));
    const keep = (list) => (list || []).filter((id) => !purge.has(id));
    for (const t of db.tasks.values()) {
      if (purge.has(t.uuid)) continue;
      const p = {};
      if ((t.tags || []).some((id) => purge.has(id))) p.tg = keep(t.tags);
      if (purge.has(t.area)) p.ar = [];
      if (Object.keys(p).length) changes.push({ [t.uuid]: { t: 1, e: ENTITY.task, p: { ...p, md: now } } });
    }
    for (const a of db.areas.values()) {
      if (!purge.has(a.uuid) && (a.tags || []).some((id) => purge.has(id))) changes.push({ [a.uuid]: { t: 1, e: ENTITY.area, p: { tg: keep(a.tags), md: now } } });
    }
    for (const g of db.tags.values()) {
      if (!purge.has(g.uuid) && purge.has(g.parent)) changes.push({ [g.uuid]: { t: 1, e: ENTITY.tag, p: { pn: [], md: now } } });
    }
    return changes;
  }

  // Permanently remove an item. The entity name is taken from the database.
  async deleteEntity(uuid) {
    const db = await this.syncDatabase();
    if (!db.entityOf(uuid)) throw new Error(`No item with id ${uuid}.`);
    await this.commitChanges(this.purgeChanges(db, [uuid]));
    return { id: uuid, deleted: true };
  }

  // --- Projects and headings --------------------------------------------------

  async createProject({
    title,
    notes = "",
    area = null,
    when = "anytime",
    deadline = null,
    tags = [],
    status = 0,
    completionDate = null,
    creationDate = null,
  }) {
    const db = await this.syncDatabase();
    const uuid = generateUUID();
    const change = buildTaskCreate({
      title,
      notes,
      type: 1,
      when,
      deadline,
      area: area ? db.resolveRef("area", area) : null,
      tags: this.resolveTagIds(db, tags),
      status,
      creationDate,
      completionDate,
      timeZone: this.timeZone,
    });
    await this.commitChanges([{ [uuid]: change }]);
    return { id: uuid, title, type: "project", status: status === 3 ? "completed" : status === 2 ? "canceled" : "open" };
  }

  async updateProject(uuid, updates = {}) {
    const db = await this.syncDatabase();
    const task = db.tasks.get(uuid);
    if (!task || task.type !== 1) throw new Error(`No project with id ${uuid}.`);
    return this.updateTodo(uuid, updates);
  }

  async createHeading({ project, title }) {
    const db = await this.syncDatabase();
    const projectId = db.resolveRef("project", project);
    const uuid = generateUUID();
    const change = buildTaskCreate({ title, type: 2, when: "anytime", project: projectId, timeZone: this.timeZone });
    await this.commitChanges([{ [uuid]: change }]);
    return { id: uuid, title, project: projectId, type: "heading" };
  }

  async updateHeading(uuid, { title, deleted = false }) {
    if (deleted) return this.deleteEntity(uuid);
    const db = await this.syncDatabase();
    if (db.tasks.get(uuid)?.type !== 2) throw new Error(`No heading with id ${uuid}.`);
    await this.commitChanges([{ [uuid]: { t: 1, e: ENTITY.task, p: { tt: title, md: toUnixTimestamp() } } }]);
    return { id: uuid, title, updated: true };
  }

  // --- Areas and tags ---------------------------------------------------------

  async createArea({ title, tags = [] }) {
    const db = await this.syncDatabase();
    const uuid = generateUUID();
    await this.commitChanges([
      { [uuid]: { t: 0, e: ENTITY.area, p: { tt: title, tg: this.resolveTagIds(db, tags), ix: 0, xx: EMPTY_XX() } } },
    ]);
    return { id: uuid, title };
  }

  async updateArea(uuid, { title }) {
    const db = await this.syncDatabase();
    if (!db.areas.has(uuid)) throw new Error(`No area with id ${uuid}.`);
    await this.commitChanges([{ [uuid]: { t: 1, e: ENTITY.area, p: { tt: title } } }]);
    return { id: uuid, title, updated: true };
  }

  async deleteArea(uuid, { deleteContents = false } = {}) {
    const db = await this.syncDatabase();
    if (!db.areas.has(uuid)) throw new Error(`No area with id ${uuid}.`);
    const changes = [];
    const now = toUnixTimestamp();

    // Items always lose the reference to the deleted area; with deleteContents they are trashed too.
    for (const t of db.tasks.values()) {
      if (t.area !== uuid) continue;
      const p = { ar: [], md: now };
      if (deleteContents && !t.trashed) p.tr = true;
      changes.push({ [t.uuid]: { t: 1, e: ENTITY.task, p } });
    }

    changes.push({ [uuid]: { t: 2, e: ENTITY.area, p: {} } });
    await this.commitChanges(changes);
    return { id: uuid, deleted: true, contentsPurged: deleteContents };
  }

  async createTag({ title, shortcut = null, parent = null }) {
    const db = await this.syncDatabase();
    const uuid = generateUUID();
    await this.commitChanges([
      {
        [uuid]: {
          t: 0,
          e: ENTITY.tag,
          p: {
            tt: title,
            sh: shortcut || null,
            pn: parent ? [db.resolveRef("tag", parent)] : [],
            ix: 0,
            xx: EMPTY_XX(),
          },
        },
      },
    ]);
    return { id: uuid, title, shortcut, parent };
  }

  async updateTag(uuid, { title, shortcut, parent }) {
    const db = await this.syncDatabase();
    if (!db.tags.has(uuid)) throw new Error(`No tag with id ${uuid}.`);
    const now = toUnixTimestamp();
    const p = { md: now };
    if (title !== undefined) p.tt = title;
    if (shortcut !== undefined) p.sh = shortcut || null;
    if (parent !== undefined) p.pn = parent ? [db.resolveRef("tag", parent)] : [];
    await this.commitChanges([{ [uuid]: { t: 1, e: ENTITY.tag, p } }]);
    return { id: uuid, updated: true };
  }

  async deleteTag(uuid) {
    const db = await this.syncDatabase();
    if (!db.tags.has(uuid)) throw new Error(`No tag with id ${uuid}.`);
    await this.commitChanges(this.purgeChanges(db, [uuid]));
    return { id: uuid, deleted: true };
  }

  // --- Checklist items --------------------------------------------------------

  async addChecklistItems(taskUUID, items) {
    const db = await this.syncDatabase();
    const task = db.tasks.get(taskUUID);
    if (!task || task.type !== 0) throw new Error(`No to-do with id ${taskUUID}.`);
    const now = toUnixTimestamp();
    let nextIndex = db.checklistItemsFor(taskUUID).reduce((max, c) => Math.max(max, c.index ?? 0), -1) + 1;

    const changes = [];
    const created = [];
    for (const item of items) {
      const id = generateUUID();
      const title = typeof item === "string" ? item : item.title;
      changes.push({ [id]: buildChecklistCreate({ title, task: taskUUID, index: nextIndex++, now }) });
      created.push({ id, title, status: "open" });
    }
    await this.commitChanges(changes);
    return created;
  }

  async setChecklist(taskUUID, items) {
    const db = await this.syncDatabase();
    const task = db.tasks.get(taskUUID);
    if (!task || task.type !== 0) throw new Error(`No to-do with id ${taskUUID}.`);

    const existingChecklist = db.checklistItemsFor(taskUUID);
    const changes = [];
    const now = toUnixTimestamp();

    for (const c of existingChecklist) {
      changes.push({ [c.uuid]: { t: 2, e: ENTITY.checklist, p: {} } });
    }

    const created = [];
    items.forEach((item, idx) => {
      const id = generateUUID();
      const title = typeof item === "string" ? item : item.title || "Untitled";
      let status = 0;
      if (typeof item === "object") {
        if (item.status === "completed" || item.completed === true) status = 3;
        else if (item.status === "canceled" || item.canceled === true) status = 2;
      }
      changes.push({
        [id]: buildChecklistCreate({
          title,
          task: taskUUID,
          index: idx,
          status,
          now,
        }),
      });
      created.push({ id, title, status: status === 3 ? "completed" : status === 2 ? "canceled" : "open" });
    });

    await this.commitChanges(changes);
    return { taskId: taskUUID, checklist: created, count: created.length };
  }

  async updateChecklistItem(uuid, { title, status }) {
    const db = await this.syncDatabase();
    if (!db.checklists.has(uuid)) throw new Error(`No checklist item with id ${uuid}.`);
    const now = toUnixTimestamp();
    const p = { md: now, ...statusFields(status, now) };
    if (title !== undefined) p.tt = title;
    await this.commitChanges([{ [uuid]: { t: 1, e: ENTITY.checklist, p } }]);
    return { id: uuid, updated: true };
  }

  async deleteChecklistItem(uuid) {
    return this.deleteEntity(uuid);
  }

  // --- Compound operations -----------------------------------------------------

  async duplicateTodo(uuid) {
    const db = await this.syncDatabase();
    const orig = db.tasks.get(uuid);
    if (!orig) throw new Error(`To-do not found: ${uuid}`);
    return this.createTodo({
      title: `${orig.title || "Untitled"} (Copy)`,
      notes: orig.notes || "",
      when: db.whenOf(orig),
      deadline: orig.deadline,
      reminderTime: secondsToTime(orig.reminderSeconds),
      project: orig.project,
      heading: orig.heading,
      area: orig.area,
      tags: orig.tags || [],
      checklist: db.checklistItemsFor(uuid).map((c) => c.title),
    });
  }

  async emptyTrash() {
    const db = await this.syncDatabase();
    const trashed = [...db.tasks.values()].filter((t) => t.trashed);
    if (!trashed.length) return { purgedCount: 0 };
    await this.commitChanges(this.purgeChanges(db, trashed.map((t) => t.uuid)));
    return { purgedCount: trashed.length };
  }

  async moveTodo(uuid, { when, project, heading, area }) {
    const updates = {};
    if (when !== undefined) updates.when = when;
    if (project !== undefined) updates.project = project;
    if (heading !== undefined) updates.heading = heading;
    if (area !== undefined) updates.area = area;
    return this.updateTodo(uuid, updates);
  }

  // Turn a to-do into a project; its checklist items become to-dos inside it.
  async convertTodoToProject(uuid) {
    const db = await this.syncDatabase();
    const task = db.tasks.get(uuid);
    if (!task || task.type !== 0) throw new Error(`To-do not found: ${uuid}`);

    const checklistItems = db.checklistItemsFor(uuid);
    const now = toUnixTimestamp();
    const changes = [{ [uuid]: { t: 1, e: ENTITY.task, p: { tp: 1, pr: [], agr: [], md: now } } }];

    checklistItems.forEach((item, idx) => {
      const todo = buildTaskCreate({
        title: item.title,
        when: "anytime",
        project: uuid,
        status: item.status === 3 ? 3 : item.status === 2 ? 2 : 0,
        now,
        timeZone: this.timeZone,
      });
      todo.p.ix = idx;
      changes.push({ [generateUUID()]: todo });
      changes.push({ [item.uuid]: { t: 2, e: ENTITY.checklist, p: {} } });
    });

    await this.commitChanges(changes);
    return { id: uuid, title: task.title, type: "project", tasksCreated: checklistItems.length };
  }

  // Import Things JSON (https://culturedcode.com/things/support/articles/2803573/).
  async importJson(payload) {
    // Later items resolve titles of earlier ones, so created items are applied to a copy of the
    // cache. A refused or failed commit then leaves the cached database untouched.
    const db = (await this.syncDatabase()).clone();
    const items = Array.isArray(payload) ? payload : [payload];
    const now = toUnixTimestamp();
    const changes = [];
    let projectsCreated = 0;
    let todosCreated = 0;
    let projectsUpdated = 0;
    let todosUpdated = 0;
    const itemResults = [];

    const addChecklist = (attrs, todoUUID) => {
      (attrs["checklist-items"] || attrs.checklist || []).forEach((cl, idx) => {
        const title = typeof cl === "string" ? cl : cl.title || cl.attributes?.title;
        const isCompleted = typeof cl === "object" && (cl.completed === true || cl.status === "completed" || cl.attributes?.completed === true);
        const isCanceled = typeof cl === "object" && (cl.canceled === true || cl.status === "canceled" || cl.attributes?.canceled === true);
        const status = isCompleted ? 3 : isCanceled ? 2 : 0;
        changes.push({
          [generateUUID()]: buildChecklistCreate({
            title,
            task: todoUUID,
            index: idx,
            status,
            now,
          }),
        });
      });
    };

    // The connector mints every new id itself. An id on a create usually means the caller meant
    // "operation": "update"; writing it would fork or overwrite an item, so refuse instead.
    const rejectCallerIds = (list, where) => {
      for (const entry of list || []) {
        if ((entry.operation || "create") === "create" && entry.id) {
          throw new Error(`${where} "${entry.id}" has an id but no "operation": "update". Ids are only accepted on updates; new items get their ids from Things.`);
        }
      }
    };
    // Nothing may be dropped silently: an entry this importer cannot write is an error, not a no-op.
    for (const item of items) {
      if (!isPlainObject(item)) throw new Error("Each import entry must be an object with a type and attributes.");
      if (!["to-do", "project", undefined].includes(item.type)) throw new Error(`Unsupported top-level type "${item.type}"; use "to-do" or "project".`);
      for (const sub of item.attributes?.items || []) {
        if (!isPlainObject(sub) || !["to-do", "heading", undefined].includes(sub.type)) {
          throw new Error(`Unsupported project child type "${sub?.type}"; use "to-do" or "heading".`);
        }
      }
    }
    rejectCallerIds(items, "Item");
    for (const item of items) rejectCallerIds(item.attributes?.items, "Project child");

    for (const item of items) {
      const type = item.type || "to-do";
      const operation = item.operation || "create";
      const attrs = item.attributes || {};

      if (operation === "update") {
        if (!item.id) {
          throw new Error(`Update operation requires an "id".`);
        }
        const existing = db.tasks.get(item.id);
        if (!existing) {
          throw new Error(`No to-do or project with id ${item.id}.`);
        }
        if (type === "project" && existing.type !== 1) {
          throw new Error(`Item ${item.id} is not a project.`);
        }
        if (type === "to-do" && existing.type !== 0) {
          throw new Error(`Item ${item.id} is not a to-do.`);
        }

        const patch = this.buildTaskPatch(db, { ...attrs, __uuid: item.id }, now);
        changes.push({ [item.id]: { t: 1, e: ENTITY.task, p: patch } });
        db.applyChangeMap({ [item.id]: { t: 1, e: ENTITY.task, p: patch } });
        if (type === "project") projectsUpdated++;
        else todosUpdated++;
        itemResults.push({ id: item.id, type, operation: "updated", title: patch.tt || existing.title || "Untitled" });
        if (attrs["checklist-items"] || attrs.checklist) {
          addChecklist(attrs, item.id);
        }
      } else if (type === "project") {
        const projectUUID = generateUUID();
        const areaId = attrs["area-id"]
          ? db.resolveRef("area", attrs["area-id"])
          : attrs.area
          ? db.resolveRef("area", attrs.area)
          : null;
        const status = attrs.completed === true ? 3 : attrs.canceled === true ? 2 : (attrs.status === "completed" ? 3 : attrs.status === "canceled" ? 2 : 0);
        const projectChange = buildTaskCreate({
          title: attrs.title || "Untitled Project",
          notes: attrs.notes || "",
          type: 1,
          when: attrs.when || "anytime",
          deadline: attrs.deadline || null,
          reminderTime: attrs.reminder || attrs["reminder-time"] || null,
          tags: this.resolveTagIds(db, attrs.tags || []),
          area: areaId,
          status,
          creationDate: attrs["creation-date"] || attrs.creationDate || attrs.creation_date || null,
          completionDate: attrs["completion-date"] || attrs.completionDate || attrs.completion_date || null,
          now,
          timeZone: this.timeZone,
        });
        changes.push({ [projectUUID]: projectChange });
        db.applyChangeMap({ [projectUUID]: projectChange });
        projectsCreated++;
        itemResults.push({ id: projectUUID, type: "project", operation: "created", title: attrs.title || "Untitled Project" });

        let headingUUID = null;
        let idx = 0;
        for (const sub of attrs.items || []) {
          const subType = sub.type || "to-do";
          const subAttrs = sub.attributes || {};
          if (subType === "heading") {
            headingUUID = generateUUID();
            const headingChange = buildTaskCreate({
              title: subAttrs.title || "Section",
              type: 2,
              when: "anytime",
              project: projectUUID,
              now,
              timeZone: this.timeZone,
            });
            changes.push({ [headingUUID]: headingChange });
            db.applyChangeMap({ [headingUUID]: headingChange });
          } else if (subType === "to-do") {
            const todoUUID = generateUUID();
            const subStatus = subAttrs.completed === true ? 3 : subAttrs.canceled === true ? 2 : (subAttrs.status === "completed" ? 3 : subAttrs.status === "canceled" ? 2 : 0);
            const change = buildTaskCreate({
              title: subAttrs.title || "Untitled",
              notes: subAttrs.notes || "",
              type: 0,
              when: subAttrs.when || "anytime",
              deadline: subAttrs.deadline || null,
              reminderTime: subAttrs.reminder || subAttrs["reminder-time"] || null,
              tags: this.resolveTagIds(db, subAttrs.tags || []),
              project: headingUUID ? null : projectUUID,
              heading: headingUUID,
              status: subStatus,
              creationDate: subAttrs["creation-date"] || subAttrs.creationDate || subAttrs.creation_date || null,
              completionDate: subAttrs["completion-date"] || subAttrs.completionDate || subAttrs.completion_date || null,
              now,
              timeZone: this.timeZone,
            });
            change.p.ix = idx++;
            changes.push({ [todoUUID]: change });
            db.applyChangeMap({ [todoUUID]: change });
            todosCreated++;
            itemResults.push({ id: todoUUID, type: "to-do", operation: "created", title: subAttrs.title || "Untitled" });
            addChecklist(subAttrs, todoUUID);
          }
        }
      } else if (type === "to-do") {
        const todoUUID = generateUUID();
        let project = null;
        let heading = null;
        let area = null;

        if (attrs["heading-id"] || attrs.heading) {
          heading = db.resolveRef("heading", attrs["heading-id"] || attrs.heading);
        } else if (attrs["list-id"] || attrs.list) {
          const listRef = db.resolveListRef(attrs["list-id"] || attrs.list);
          if (listRef.type === "project") project = listRef.id;
          else area = listRef.id;
        } else if (attrs["area-id"] || attrs.area) {
          area = db.resolveRef("area", attrs["area-id"] || attrs.area);
        }

        let when = attrs.when;
        if (!when) {
          if (project || heading || area) {
            when = "anytime";
          } else {
            when = "inbox";
          }
        }

        const status = attrs.completed === true ? 3 : attrs.canceled === true ? 2 : (attrs.status === "completed" ? 3 : attrs.status === "canceled" ? 2 : 0);
        const todoChange = buildTaskCreate({
          title: attrs.title || "Untitled",
          notes: attrs.notes || "",
          type: 0,
          when,
          deadline: attrs.deadline || null,
          reminderTime: attrs.reminder || attrs["reminder-time"] || null,
          tags: this.resolveTagIds(db, attrs.tags || []),
          project,
          heading,
          area,
          status,
          creationDate: attrs["creation-date"] || attrs.creationDate || attrs.creation_date || null,
          completionDate: attrs["completion-date"] || attrs.completionDate || attrs.completion_date || null,
          now,
          timeZone: this.timeZone,
        });

        changes.push({ [todoUUID]: todoChange });
        db.applyChangeMap({ [todoUUID]: todoChange });
        todosCreated++;
        itemResults.push({ id: todoUUID, type: "to-do", operation: "created", title: attrs.title || "Untitled" });
        addChecklist(attrs, todoUUID);
      }
    }

    await this.commitChanges(changes);
    return {
      projectsCreated,
      todosCreated,
      projectsUpdated,
      todosUpdated,
      totalEntities: changes.length,
      items: itemResults,
    };
  }

  async addTagsToTask(taskUUID, tagNames) {
    const db = await this.syncDatabase();
    const task = db.tasks.get(taskUUID);
    if (!task) throw new Error(`Task not found: ${taskUUID}`);
    const merged = [...new Set([...(task.tags || []), ...this.resolveTagIds(db, tagNames)])];
    return this.updateTodo(taskUUID, { tags: merged });
  }

  async removeTagsFromTask(taskUUID, tagNames) {
    const db = await this.syncDatabase();
    const task = db.tasks.get(taskUUID);
    if (!task) throw new Error(`Task not found: ${taskUUID}`);
    const remove = new Set(this.resolveTagIds(db, tagNames));
    return this.updateTodo(taskUUID, { tags: (task.tags || []).filter((id) => !remove.has(id)) });
  }

  // One commit: every item lands or none does. The result lists each item so the caller can see
  // exactly what was written; any unknown id refuses the whole batch and names every bad id.
  async batchUpdateTodos(uuids, operation, options = {}) {
    if (operation === "reschedule" && !options.when) throw new Error('Operation "reschedule" needs "when".');
    if (operation === "set_dates" && !(options.deadline || options.completionDate || options.completion_date || options.creationDate || options.creation_date)) {
      throw new Error('Operation "set_dates" needs deadline, completion_date, or creation_date.');
    }
    const db = await this.syncDatabase();
    return this.commitBatch(db, uuids, operation, "Task", (uuid) => db.tasks.has(uuid), (uuid, now) =>
      this.buildTaskPatch(db, {
        __uuid: uuid,
        status: operation === "complete" ? "completed" : operation === "cancel" ? "canceled" : undefined,
        trashed: operation === "trash" ? true : undefined,
        when: options.when,
        deadline: options.deadline,
        completionDate: options.completionDate || options.completion_date,
        creationDate: options.creationDate || options.creation_date,
      }, now)
    );
  }

  async batchUpdateProjects(uuids, operation, options = {}) {
    if (operation === "reschedule" && !options.when) throw new Error('Operation "reschedule" needs "when".');
    if (operation === "set_area" && !options.area) throw new Error('Operation "set_area" needs "area".');
    const db = await this.syncDatabase();
    return this.commitBatch(db, uuids, operation, "Project", (uuid) => db.tasks.get(uuid)?.type === 1, (uuid, now) =>
      this.buildTaskPatch(db, {
        __uuid: uuid,
        status: operation === "complete" ? "completed" : operation === "cancel" ? "canceled" : undefined,
        trashed: operation === "trash" ? true : undefined,
        when: options.when,
        area: options.area,
        deadline: options.deadline,
        completionDate: options.completionDate || options.completion_date,
        creationDate: options.creationDate || options.creation_date,
      }, now)
    );
  }

  async commitBatch(db, uuids, operation, label, exists, patchFor) {
    const ids = [...new Set(uuids)];
    const missing = ids.filter((uuid) => !exists(uuid));
    if (missing.length) throw new Error(`${label} not found: ${missing.join(", ")}. Nothing was written.`);
    const now = toUnixTimestamp();
    const changes = ids.map((uuid) => ({ [uuid]: { t: 1, e: ENTITY.task, p: patchFor(uuid, now) } }));
    await this.commitChanges(changes);
    const items = ids.map((id) => ({ id, title: db.tasks.get(id)?.title || null, result: "updated" }));
    return { count: ids.length, operation, updated: true, items };
  }

  async importCsv(csvText, { defaultProject = null, defaultArea = null } = {}) {
    const items = convertCsvToThingsJson(csvText, { defaultProject, defaultArea });
    return this.importJson(items);
  }
}

// ---------------------------------------------------------------------------
// CSV parsing and Asana / CSV migration helpers
// ---------------------------------------------------------------------------

export function parseCSV(csvText) {
  const rows = [];
  let currentRow = [];
  let currentField = "";
  let insideQuotes = false;
  let i = 0;

  while (i < csvText.length) {
    const char = csvText[i];
    const nextChar = csvText[i + 1];

    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        currentField += '"';
        i += 2;
        continue;
      } else {
        insideQuotes = !insideQuotes;
        i++;
        continue;
      }
    }

    if (!insideQuotes && char === ',') {
      currentRow.push(currentField.trim());
      currentField = "";
      i++;
      continue;
    }

    if (!insideQuotes && (char === '\r' || char === '\n')) {
      if (char === '\r' && nextChar === '\n') i++;
      currentRow.push(currentField.trim());
      if (currentRow.some((f) => f.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentField = "";
      i++;
      continue;
    }

    currentField += char;
    i++;
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (currentRow.some((f) => f.length > 0)) {
      rows.push(currentRow);
    }
  }

  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const data = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = row[idx] || "";
    });
    data.push(obj);
  }
  return data;
}

export function convertCsvToThingsJson(csvText, { defaultProject = null, defaultArea = null } = {}) {
  const records = parseCSV(csvText);
  if (!records.length) return [];

  const tasks = [];
  for (const row of records) {
    const title = row.name || row.title || row.taskname || row.summary || row.todo || "";
    if (!title) continue;

    const notes = row.notes || row.description || "";
    const deadline = row.duedate || row.deadline || row.due || null;
    const when = row.startdate || row.when || row.start || null;
    const creationDate = row.createdat || row.creationdate || null;
    const completionDate = row.completedat || row.completiondate || null;
    const isCompleted = Boolean(completionDate || (row.completed && row.completed.toLowerCase() === "true"));
    const list = row.project || row.projects || row.list || defaultProject || null;
    const area = row.area || defaultArea || null;
    const heading = row.sectioncolumn || row.section || row.column || row.heading || null;
    const rawTags = row.tags || row.labels || "";
    const tags = rawTags ? rawTags.split(/[,;]/).map((t) => t.trim()).filter(Boolean) : [];

    const attrs = {
      title,
      notes,
      completed: isCompleted,
    };
    if (deadline) attrs.deadline = deadline;
    if (when) attrs.when = when;
    if (creationDate) attrs["creation-date"] = creationDate;
    if (completionDate) attrs["completion-date"] = completionDate;
    if (list) attrs.list = list;
    if (area) attrs.area = area;
    if (heading) attrs.heading = heading;
    if (tags.length) attrs.tags = tags;

    tasks.push({
      type: "to-do",
      attributes: attrs,
    });
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// In-memory database built from the history
// ---------------------------------------------------------------------------

const first = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : null);

export class ThingsDatabase {
  constructor(timeZone = DEFAULT_TIME_ZONE) {
    this.timeZone = timeZone;
    this.tasks = new Map();
    this.areas = new Map();
    this.tags = new Map();
    this.checklists = new Map();
    this.latestServerIndex = 0;
  }

  today() {
    return localDate(this.timeZone);
  }

  // Entities are replaced, never mutated, so copying the maps is enough for an independent copy.
  clone() {
    const copy = new ThingsDatabase(this.timeZone);
    copy.tasks = new Map(this.tasks);
    copy.areas = new Map(this.areas);
    copy.tags = new Map(this.tags);
    copy.checklists = new Map(this.checklists);
    copy.latestServerIndex = this.latestServerIndex;
    return copy;
  }

  applyChangeMap(changeMap) {
    for (const [uuid, op] of Object.entries(changeMap)) {
      if (op.t === 2) {
        this.tasks.delete(uuid);
        this.areas.delete(uuid);
        this.tags.delete(uuid);
        this.checklists.delete(uuid);
        continue;
      }

      const entity = op.e || "";
      const props = op.p || {};
      if (entity.startsWith("Task")) {
        this.tasks.set(uuid, this.mergeTask(this.tasks.get(uuid) || { uuid }, props));
      } else if (entity.startsWith("ChecklistItem")) {
        this.checklists.set(uuid, this.mergeChecklist(this.checklists.get(uuid) || { uuid }, props));
      } else if (entity.startsWith("Area")) {
        this.areas.set(uuid, this.mergeArea(this.areas.get(uuid) || { uuid }, props));
      } else if (entity.startsWith("Tag")) {
        this.tags.set(uuid, this.mergeTag(this.tags.get(uuid) || { uuid }, props));
      }
    }
  }

  static mergeNotes(existing, nt) {
    if (nt === null || nt === undefined) return existing;
    if (typeof nt.v === "string") return nt.v;
    if (Array.isArray(nt.ps)) return applyNotePatches(existing, nt.ps);
    return existing;
  }

  mergeTask(t, p) {
    const out = { ...t };
    if ("tt" in p) out.title = p.tt ?? "";
    if ("nt" in p) out.notes = ThingsDatabase.mergeNotes(out.notes || "", p.nt);
    if ("tp" in p) out.type = p.tp;
    if ("ss" in p) out.status = p.ss;
    if ("tr" in p) out.trashed = Boolean(p.tr);
    if ("st" in p) out.start = p.st;
    if ("sb" in p) out.startBucket = p.sb;
    if ("sr" in p) out.startDate = timestampToDate(p.sr);
    if ("tir" in p) out.todayRefDate = timestampToDate(p.tir);
    if ("dd" in p) out.deadline = timestampToDate(p.dd);
    if ("ato" in p) out.reminderSeconds = p.ato;
    if ("pr" in p) out.project = first(p.pr);
    if ("agr" in p) out.heading = first(p.agr);
    if ("ar" in p) out.area = first(p.ar);
    if ("tg" in p) out.tags = p.tg || [];
    if ("ix" in p) out.index = p.ix;
    if ("ti" in p) out.todayIndex = p.ti;
    if ("cd" in p) out.creationDate = p.cd;
    if ("md" in p) out.modificationDate = p.md;
    if ("sp" in p) out.stopDate = p.sp;
    if ("rr" in p) out.recurrenceRule = p.rr;
    if ("rt" in p) out.repeatingTemplates = p.rt || [];
    return out;
  }

  mergeChecklist(c, p) {
    const out = { ...c };
    if ("tt" in p) out.title = p.tt ?? "";
    if ("ss" in p) out.status = p.ss;
    if ("ts" in p) out.task = first(p.ts);
    if ("ix" in p) out.index = p.ix;
    if ("sp" in p) out.stopDate = p.sp;
    return out;
  }

  mergeArea(a, p) {
    const out = { ...a };
    if ("tt" in p) out.title = p.tt ?? "";
    if ("tg" in p) out.tags = p.tg || [];
    if ("ix" in p) out.index = p.ix;
    return out;
  }

  mergeTag(t, p) {
    const out = { ...t };
    if ("tt" in p) out.title = p.tt ?? "";
    if ("sh" in p) out.shortcut = p.sh;
    if ("pn" in p) out.parent = first(p.pn);
    if ("ix" in p) out.index = p.ix;
    return out;
  }

  // --- Lookups ----------------------------------------------------------------

  entityOf(uuid) {
    if (this.tasks.has(uuid)) return ENTITY.task;
    if (this.areas.has(uuid)) return ENTITY.area;
    if (this.tags.has(uuid)) return ENTITY.tag;
    if (this.checklists.has(uuid)) return ENTITY.checklist;
    return null;
  }

  // Turn an id or a (case-insensitive) title into an id; throws if nothing or several match.
  resolveRef(kind, value) {
    const wanted = String(value).trim();
    const pools = {
      tag: [this.tags, (t) => true],
      area: [this.areas, () => true],
      project: [this.tasks, (t) => t.type === 1 && !t.trashed],
      heading: [this.tasks, (t) => t.type === 2 && !t.trashed],
    };
    const [map, accept] = pools[kind];
    const byId = map.get(wanted);
    if (byId && accept(byId)) return wanted;

    const matches = [...map.values()].filter((item) => accept(item) && (item.title || "").toLowerCase() === wanted.toLowerCase());
    if (matches.length === 1) return matches[0].uuid;
    if (matches.length > 1) {
      throw new Error(`More than one ${kind} is named "${wanted}". Use its id instead: ${matches.map((m) => m.uuid).join(", ")}.`);
    }
    const hint = kind === "tag" ? " Create it with create_tag first." : "";
    throw new Error(`No ${kind} found for "${wanted}".${hint}`);
  }

  // Resolve a list reference which can be either a project or an area.
  resolveListRef(value) {
    const wanted = String(value).trim();
    const task = this.tasks.get(wanted);
    if (task && task.type === 1 && !task.trashed) return { type: "project", id: wanted };
    if (this.areas.has(wanted)) return { type: "area", id: wanted };

    const wantedLower = wanted.toLowerCase();
    const matchingProjects = [...this.tasks.values()].filter(
      (t) => t.type === 1 && !t.trashed && (t.title || "").toLowerCase() === wantedLower
    );
    const matchingAreas = [...this.areas.values()].filter(
      (a) => (a.title || "").toLowerCase() === wantedLower
    );

    const totalMatches = matchingProjects.length + matchingAreas.length;
    if (totalMatches === 1) {
      if (matchingProjects.length === 1) return { type: "project", id: matchingProjects[0].uuid };
      return { type: "area", id: matchingAreas[0].uuid };
    }
    if (totalMatches > 1) {
      const allIds = [...matchingProjects, ...matchingAreas].map((m) => m.uuid).join(", ");
      throw new Error(`More than one project or area is named "${wanted}". Use its id instead: ${allIds}.`);
    }
    throw new Error(`No project or area found for "${wanted}".`);
  }

  tagTitles(ids = []) {
    return ids.map((id) => this.tags.get(id)?.title || id);
  }

  projectIdOf(t) {
    return t.project || (t.heading ? this.tasks.get(t.heading)?.project : null) || null;
  }

  checklistItemsFor(taskUUID) {
    return [...this.checklists.values()]
      .filter((c) => c.task === taskUUID)
      .sort((a, b) => (a.index || 0) - (b.index || 0));
  }

  resolveChecklistItems(taskUUID) {
    return this.checklistItemsFor(taskUUID).map((c) => ({
      id: c.uuid,
      title: c.title,
      status: c.status === 3 ? "completed" : c.status === 2 ? "canceled" : "open",
    }));
  }

  whenOf(t) {
    if (t.start === 0) return "inbox";
    if (t.start === 2) return t.startDate || "someday";
    if (t.startDate && t.startDate <= this.today()) return t.startBucket === 1 ? "evening" : "today";
    return t.startDate || "anytime";
  }

  formatTask(t) {
    const projectId = this.projectIdOf(t);
    const checklist = this.resolveChecklistItems(t.uuid);

    return {
      id: t.uuid,
      title: t.title,
      notes: t.notes || "",
      status: t.status === 3 ? "completed" : t.status === 2 ? "canceled" : "open",
      when: this.whenOf(t),
      scheduledDate: t.startDate || null,
      deadline: t.deadline || null,
      reminderTime: secondsToTime(t.reminderSeconds),
      creationDate: t.creationDate ? new Date(t.creationDate * 1000).toISOString() : null,
      completionDate: t.stopDate ? new Date(t.stopDate * 1000).toISOString() : null,
      project: projectId ? this.tasks.get(projectId)?.title || projectId : null,
      projectId,
      heading: t.heading ? this.tasks.get(t.heading)?.title || t.heading : null,
      headingId: t.heading || null,
      area: t.area ? this.areas.get(t.area)?.title || t.area : null,
      areaId: t.area || null,
      tags: this.tagTitles(t.tags),
      deepLink: `things:///show?id=${t.uuid}`,
      checklistCount: checklist.length,
      checklistCompletedCount: checklist.filter((c) => c.status === "completed").length,
      checklist: checklist.length ? checklist : undefined,
    };
  }

  // To-dos that can appear in lists: not trashed, not a repeating template.
  isLive(t) {
    return !t.trashed && !t.recurrenceRule;
  }

  getOpenTasks() {
    return [...this.tasks.values()].filter((t) => t.type === 0 && t.status === 0 && this.isLive(t));
  }

  getInbox() {
    return this.getOpenTasks()
      .filter((t) => t.start === 0)
      .map((t) => this.formatTask(t));
  }

  getToday() {
    const today = this.today();
    return this.getOpenTasks()
      .filter((t) => t.start === 1 && t.startDate && t.startDate <= today)
      .sort((a, b) => (a.startBucket || 0) - (b.startBucket || 0) || (a.todayIndex || 0) - (b.todayIndex || 0))
      .map((t) => this.formatTask(t));
  }

  getUpcoming(days = 14) {
    const today = this.today();
    const last = addDays(today, days);
    return this.getOpenTasks()
      .filter((t) => {
        const scheduled = t.startDate && t.startDate > today && t.startDate <= last;
        const hasDeadline = t.deadline && t.deadline <= last;
        return scheduled || hasDeadline;
      })
      .sort((a, b) => (a.startDate || a.deadline || "").localeCompare(b.startDate || b.deadline || ""))
      .map((t) => this.formatTask(t));
  }

  matchesArea(t, area) {
    return !area || t.area === area || this.areas.get(t.area)?.title === area;
  }

  matchesTag(t, tag) {
    return !tag || (t.tags || []).some((id) => id === tag || this.tags.get(id)?.title === tag);
  }

  getAnytime({ area = null, tag = null } = {}) {
    return this.getOpenTasks()
      .filter((t) => t.start === 1 && this.matchesArea(t, area) && this.matchesTag(t, tag))
      .map((t) => this.formatTask(t));
  }

  getSomeday() {
    return this.getOpenTasks()
      .filter((t) => t.start === 2 && !t.startDate)
      .map((t) => this.formatTask(t));
  }

  getLogbook(limitOrOptions = 50, statusFilter = "all") {
    let limit = 50;
    let filter = statusFilter;
    let since = null;
    let until = null;

    if (typeof limitOrOptions === "object" && limitOrOptions !== null) {
      if (limitOrOptions.limit !== undefined) limit = limitOrOptions.limit;
      if (limitOrOptions.statusFilter !== undefined) filter = limitOrOptions.statusFilter;
      if (limitOrOptions.status !== undefined) filter = limitOrOptions.status;
      if (limitOrOptions.since !== undefined) since = limitOrOptions.since;
      if (limitOrOptions.until !== undefined) until = limitOrOptions.until;
    } else if (typeof limitOrOptions === "number") {
      limit = limitOrOptions;
    }

    const sinceTs = since ? (typeof since === "number" ? since : parseIsoDate(since)) : null;
    let untilTs = until ? (typeof until === "number" ? until : parseIsoDate(until)) : null;
    if (until && typeof until === "string" && until.length === 10 && untilTs !== null) {
      untilTs += 86399;
    }

    return [...this.tasks.values()]
      .filter((t) => {
        if (t.trashed || t.type === 2) return false;
        if (filter === "completed") {
          if (t.status !== 3) return false;
        } else if (filter === "canceled") {
          if (t.status !== 2) return false;
        } else {
          if (t.status !== 3 && t.status !== 2) return false;
        }

        const itemTs = t.stopDate || t.modificationDate || 0;
        if (sinceTs !== null && itemTs < sinceTs) return false;
        if (untilTs !== null && itemTs > untilTs) return false;

        return true;
      })
      .sort((a, b) => (b.stopDate || b.modificationDate || 0) - (a.stopDate || a.modificationDate || 0))
      .slice(0, limit)
      .map((t) => ({
        ...this.formatTask(t),
        stopDate: t.stopDate ? new Date(t.stopDate * 1000).toISOString() : null,
      }));
  }

  getRepeatingTodos() {
    return [...this.tasks.values()]
      .filter((t) => !t.trashed && t.recurrenceRule)
      .map((t) => this.formatTask(t));
  }

  getTrash() {
    return [...this.tasks.values()].filter((t) => t.trashed).map((t) => this.formatTask(t));
  }

  getProjects({ status = "open", area = null } = {}) {
    return [...this.tasks.values()]
      .filter((t) => {
        if (t.type !== 1 || t.trashed) return false;
        if (status === "open" && t.status !== 0) return false;
        if (status === "completed" && t.status !== 3) return false;
        return this.matchesArea(t, area);
      })
      .map((p) => {
        const todos = [...this.tasks.values()].filter((t) => t.type === 0 && !t.trashed && this.projectIdOf(t) === p.uuid);
        const completed = todos.filter((t) => t.status === 3 || t.status === 2).length; // canceled counts as done, as in Things
        return {
          id: p.uuid,
          title: p.title,
          notes: p.notes || "",
          status: p.status === 3 ? "completed" : p.status === 2 ? "canceled" : "open",
          area: p.area ? this.areas.get(p.area)?.title || p.area : null,
          areaId: p.area || null,
          deadline: p.deadline || null,
          scheduledDate: p.startDate || null,
          creationDate: p.creationDate ? new Date(p.creationDate * 1000).toISOString() : null,
          completionDate: p.stopDate ? new Date(p.stopDate * 1000).toISOString() : null,
          totalTasks: todos.length,
          completedTasks: completed,
          openTasks: todos.length - completed,
          tags: this.tagTitles(p.tags),
        };
      });
  }

  getProjectStats({ area = null } = {}) {
    const today = this.today();
    const allProjects = [...this.tasks.values()].filter(
      (t) => t.type === 1 && !t.trashed && this.matchesArea(t, area)
    );

    const totalProjects = allProjects.length;
    const openProjectsList = allProjects.filter((p) => p.status === 0);
    const completedProjectsList = allProjects.filter((p) => p.status === 3);
    const canceledProjectsList = allProjects.filter((p) => p.status === 2);

    let totalTodos = 0;
    let completedTodos = 0;
    let openTodos = 0;
    let overdueProjectsCount = 0;

    const projectSummaries = allProjects.map((p) => {
      const todos = [...this.tasks.values()].filter(
        (t) => t.type === 0 && !t.trashed && this.projectIdOf(t) === p.uuid
      );
      const completed = todos.filter((t) => t.status === 3 || t.status === 2).length;
      const open = todos.length - completed;
      const isOverdue = p.status === 0 && Boolean(p.deadline && p.deadline < today);

      if (p.status === 0) {
        totalTodos += todos.length;
        completedTodos += completed;
        openTodos += open;
        if (isOverdue) overdueProjectsCount++;
      }

      return {
        id: p.uuid,
        title: p.title,
        status: p.status === 3 ? "completed" : p.status === 2 ? "canceled" : "open",
        area: p.area ? this.areas.get(p.area)?.title || p.area : null,
        areaId: p.area || null,
        deadline: p.deadline || null,
        overdue: isOverdue,
        totalTasks: todos.length,
        completedTasks: completed,
        openTasks: open,
        percentComplete: todos.length > 0 ? Math.round((completed / todos.length) * 100) : 0,
      };
    });

    return {
      totalProjects,
      openProjects: openProjectsList.length,
      completedProjects: completedProjectsList.length,
      canceledProjects: canceledProjectsList.length,
      overdueProjects: overdueProjectsCount,
      activeProjectsTodos: {
        total: totalTodos,
        completed: completedTodos,
        open: openTodos,
        overallPercentComplete: totalTodos > 0 ? Math.round((completedTodos / totalTodos) * 100) : 0,
      },
      projects: projectSummaries,
    };
  }

  findProject(identifier) {
    const wanted = String(identifier).toLowerCase();
    return [...this.tasks.values()].find(
      (t) => t.type === 1 && (t.uuid === identifier || (t.title && t.title.toLowerCase() === wanted))
    );
  }

  getProject(projectIdentifier) {
    const p = this.findProject(projectIdentifier);
    if (!p) return null;

    const all = [...this.tasks.values()];
    const headings = all
      .filter((t) => t.type === 2 && t.project === p.uuid && !t.trashed)
      .sort((a, b) => (a.index || 0) - (b.index || 0))
      .map((h) => ({
        id: h.uuid,
        title: h.title,
        tasks: all.filter((t) => t.type === 0 && t.heading === h.uuid && !t.trashed).map((t) => this.formatTask(t)),
      }));

    const ungroupedTasks = all
      .filter((t) => t.type === 0 && t.project === p.uuid && !t.heading && !t.trashed)
      .map((t) => this.formatTask(t));

    return {
      id: p.uuid,
      title: p.title,
      notes: p.notes || "",
      status: p.status === 3 ? "completed" : p.status === 2 ? "canceled" : "open",
      area: p.area ? this.areas.get(p.area)?.title || p.area : null,
      areaId: p.area || null,
      deadline: p.deadline || null,
      scheduledDate: p.startDate || null,
      creationDate: p.creationDate ? new Date(p.creationDate * 1000).toISOString() : null,
      completionDate: p.stopDate ? new Date(p.stopDate * 1000).toISOString() : null,
      tags: this.tagTitles(p.tags),
      headings,
      ungroupedTasks,
    };
  }

  getAreas() {
    return [...this.areas.values()].map((a) => {
      const all = [...this.tasks.values()];
      return {
        id: a.uuid,
        title: a.title,
        tags: this.tagTitles(a.tags),
        activeProjects: all
          .filter((t) => t.type === 1 && t.area === a.uuid && t.status === 0 && !t.trashed)
          .map((p) => ({ id: p.uuid, title: p.title })),
        unprojectedTasks: all
          .filter((t) => t.type === 0 && t.area === a.uuid && !this.projectIdOf(t) && t.status === 0 && this.isLive(t))
          .map((t) => ({ id: t.uuid, title: t.title })),
      };
    });
  }

  getTags() {
    return [...this.tags.values()].map((t) => ({
      id: t.uuid,
      title: t.title,
      shortcut: t.shortcut || null,
      parent: t.parent ? this.tags.get(t.parent)?.title || t.parent : null,
      parentId: t.parent || null,
    }));
  }

  getTask(taskIdentifier) {
    const wanted = String(taskIdentifier).toLowerCase();
    const t =
      this.tasks.get(taskIdentifier) ||
      [...this.tasks.values()].find((task) => task.title && task.title.toLowerCase() === wanted);
    return t ? this.formatTask(t) : null;
  }

  search(query, { status = "open", includeNotes = true, area = null, project = null, tag = null } = {}) {
    const q = query.toLowerCase();
    return [...this.tasks.values()]
      .filter((t) => {
        if (t.trashed || t.type === 2) return false;
        if (status === "open" && t.status !== 0) return false;
        if (status === "completed" && t.status !== 3) return false;
        if (!this.matchesArea(t, area)) return false;
        if (project) {
          const pid = this.projectIdOf(t);
          if (pid !== project && this.tasks.get(pid)?.title !== project) return false;
        }
        if (!this.matchesTag(t, tag)) return false;
        return (t.title || "").toLowerCase().includes(q) || (includeNotes && (t.notes || "").toLowerCase().includes(q));
      })
      .map((t) => (t.type === 1 ? { ...this.formatTask(t), isProject: true } : this.formatTask(t)));
  }

  getDeadlines() {
    const today = this.today();
    const weekOut = addDays(today, 7);
    const overdue = [];
    const dueToday = [];
    const dueSoon = [];
    const future = [];

    for (const t of this.tasks.values()) {
      if (!this.isLive(t) || t.status !== 0 || !t.deadline || t.type === 2) continue;
      const item = this.formatTask(t);
      if (t.deadline < today) overdue.push(item);
      else if (t.deadline === today) dueToday.push(item);
      else if (t.deadline <= weekOut) dueSoon.push(item);
      else future.push(item);
    }

    const byDeadline = (a, b) => (a.deadline || "").localeCompare(b.deadline || "");
    return { overdue: overdue.sort(byDeadline), dueToday, dueSoon: dueSoon.sort(byDeadline), future: future.sort(byDeadline) };
  }

  getDailySummary() {
    const today = this.today();
    const todos = [...this.tasks.values()].filter((t) => this.isLive(t) && t.type === 0);

    const completedToday = todos
      .filter((t) => t.status === 3 && t.stopDate && localDate(this.timeZone, t.stopDate) === today)
      .map((t) => this.formatTask(t));
    const dueToday = todos.filter((t) => t.status === 0 && t.deadline === today).map((t) => this.formatTask(t));
    const overdue = todos.filter((t) => t.status === 0 && t.deadline && t.deadline < today).map((t) => this.formatTask(t));
    const todayList = this.getToday();

    return {
      date: today,
      todayAgendaCount: todayList.length,
      completedTodayCount: completedToday.length,
      overdueCount: overdue.length,
      dueTodayCount: dueToday.length,
      completedToday,
      dueToday,
      overdue,
      todayAgenda: todayList,
    };
  }

  exportMarkdown(target) {
    if (target === "today") {
      let md = `# Today (${this.today()})\n\n`;
      for (const t of this.getToday()) {
        md += `- [ ] **${t.title}**${t.project ? ` (*${t.project}*)` : ""}${t.deadline ? ` — Due: ${t.deadline}` : ""}\n`;
        if (t.notes) md += `  > ${t.notes.replace(/\n/g, "\n  > ")}\n`;
        for (const cl of t.checklist || []) md += `  - [${cl.status === "completed" ? "x" : " "}] ${cl.title}\n`;
      }
      return md;
    }

    if (target === "inbox") {
      let md = `# Inbox\n\n`;
      for (const t of this.getInbox()) {
        md += `- [ ] **${t.title}**\n`;
        if (t.notes) md += `  > ${t.notes.replace(/\n/g, "\n  > ")}\n`;
      }
      return md;
    }

    const project = this.getProject(target);
    if (!project) throw new Error(`Target not found for markdown export: ${target}`);

    const lines = (t) => {
      let out = t.status === "canceled" ? `- [x] ~~${t.title}~~\n` : `- [${t.status === "completed" ? "x" : " "}] **${t.title}**\n`;
      for (const cl of t.checklist || []) out += `  - [${cl.status === "completed" ? "x" : " "}] ${cl.title}\n`;
      return out;
    };

    let md = `# ${project.title}\n`;
    if (project.area) md += `*Area: ${project.area}*\n`;
    if (project.deadline) md += `*Deadline: ${project.deadline}*\n`;
    if (project.notes) md += `\n${project.notes}\n`;
    md += `\n`;
    if (project.ungroupedTasks.length) md += project.ungroupedTasks.map(lines).join("") + "\n";
    for (const h of project.headings) md += `### ${h.title}\n${h.tasks.map(lines).join("")}\n`;
    return md;
  }

  getSettings() {
    return { groupTodayByParent: true, logInterval: "daily", timeZone: this.timeZone };
  }

  getDeepLink(id) {
    const item = this.tasks.get(id) || this.areas.get(id) || this.tags.get(id);
    if (!item) throw new Error(`No to-do, project, heading, area, or tag with id ${id}.`);
    return { id, title: item.title, url: `things:///show?id=${encodeURIComponent(id)}` };
  }

  getStats() {
    const all = [...this.tasks.values()];
    const todos = all.filter((t) => t.type === 0 && this.isLive(t));
    const projects = all.filter((t) => t.type === 1 && !t.trashed);

    return {
      totalTodos: todos.length,
      openTodos: todos.filter((t) => t.status === 0).length,
      completedTodos: todos.filter((t) => t.status === 3).length,
      totalProjects: projects.length,
      openProjects: projects.filter((p) => p.status === 0).length,
      totalAreas: this.areas.size,
      totalTags: this.tags.size,
      totalChecklistItems: this.checklists.size,
      trashedItems: all.filter((t) => t.trashed).length,
    };
  }
}
