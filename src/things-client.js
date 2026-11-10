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
  const ts = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000;
  // Date.UTC rolls an impossible date forward (Feb 31 becomes Mar 3); refuse it instead.
  if (new Date(ts * 1000).toISOString().slice(0, 10) !== m[0]) {
    throw new Error(`Invalid date "${dateStr}": that day does not exist in the calendar.`);
  }
  return ts;
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

// An IANA time zone name ("Europe/Paris") as the runtime knows it, or an error that says what to send.
export function assertTimeZone(timeZone) {
  try {
    if (typeof timeZone !== "string" || !timeZone.trim()) throw new RangeError("empty");
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone.trim() }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`"${String(timeZone)}" is not a time zone this server knows. Use an IANA name such as "America/Los_Angeles" or "Europe/Paris".`);
  }
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

// A repeating template may only change these; scheduling keys belong to the Things apps. `rr` and
// `icp` are accepted only in the shapes sampled from Things 3.24.2 (a rule edit that keeps the next
// day, one that moves it and so also writes tir and icsd, and pause or resume); see the template
// checks in validateAgainstDatabase.
const TEMPLATE_SAFE_KEYS = new Set(["tt", "nt", "tg", "tr", "md", "pr", "agr", "ar", "ix", "rr", "icp"]);

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const illFormed = (v) => typeof v === "string" && typeof v.isWellFormed === "function" && !v.isWellFormed();
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

// The plain to-do Things 3.24.2 creates when a repeat is stopped is the only create with lt true and
// md null. Every other key of it is fixed here except title, notes, tags, container, ix, cd, and
// the day (sr and tir, which must be equal).
const STOP_CREATE_FIXED = { tp: 0, ss: 0, sp: null, tr: false, st: 2, sb: 0, ato: null, dd: null, dds: null, rmd: null, icp: false, do: 0, lai: null, lt: true, icc: 0, ti: 0, md: null, icsd: null, rp: null, acrd: null, rr: null };
const isStopCreate = (change) => change?.t === 0 && entityFamily(change.e) === "Task" && isPlainObject(change.p) && (change.p.lt === true || change.p.md === null);
// The keys of the rule edit that moves the next day (the app also rewrote ti, which is incidental).
const RULE_MOVE_KEYS = ["md", "rr", "tir", "icsd"];

// Structural equality for JSON values, ignoring key order.
function sameJson(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => k in b && sameJson(a[k], b[k]));
}

// A repeat rule in words, for the read tools. Reads whatever the Things apps wrote, so anything
// outside the known shapes is reported as unrecognized instead of guessed at.
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"}`;
const listOf = (parts) => (parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0] || "");

export function describeRepeatRule(rr, { hasDeadline = false } = {}) {
  const unit = isPlainObject(rr) ? RR_UNITS[rr.fu] : null;
  if (!unit || !Number.isInteger(rr.fa) || rr.fa < 1) return { summary: "Repeats (rule not recognized)", frequency: null };
  const noun = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[unit];
  const afterCompletion = rr.tp === 1;
  const every = rr.fa === 1 ? `Every ${noun}` : `Every ${rr.fa} ${noun}s`;
  const nth = (e) => `the ${e.wdo === -1 ? "last" : ordinal(e.wdo)} ${WEEKDAYS[e.wd]}`;
  const dayOf = (e) => (e.dy === -1 ? "the last day" : `the ${ordinal(e.dy + 1)}`);
  const of = Array.isArray(rr.of) ? rr.of.filter(isPlainObject) : [];

  let on = "";
  if (afterCompletion) on = " after completion";
  else if (unit === "weekly" && of.length) on = ` on ${listOf(of.map((e) => WEEKDAYS[e.wd] ?? "?"))}`;
  else if (unit === "monthly" && of.length) on = ` on ${listOf(of.map((e) => ("wd" in e ? nth(e) : dayOf(e))))}`;
  else if (unit === "yearly" && of.length) {
    const e = of[0];
    on = "wd" in e ? ` on ${nth(e)} of ${MONTHS[e.mo] ?? "?"}` : e.dy === -1 ? ` on the last day of ${MONTHS[e.mo] ?? "?"}` : ` on ${MONTHS[e.mo] ?? "?"} ${e.dy + 1}`;
  }

  const endsOn = isNum(rr.ed) && rr.ed < RR_FAR_FUTURE ? timestampToDate(rr.ed) : null;
  const count = Number.isInteger(rr.rc) && rr.rc > 0 ? rr.rc : null;
  // With "Add deadlines" on, each date of the rule is a deadline and rr.ts is how many days before
  // it the occurrence starts (0 or negative).
  const startsDaysBeforeDeadline = hasDeadline && Number.isInteger(rr.ts) ? Math.abs(rr.ts) : null;
  let summary = `${every}${on}`;
  if (count) summary += `, ${count} time${count === 1 ? "" : "s"}`;
  if (endsOn) summary += `, until ${endsOn}`;
  if (hasDeadline) {
    summary += startsDaysBeforeDeadline ? `; each date is a deadline and the to-do starts ${startsDaysBeforeDeadline} day${startsDaysBeforeDeadline === 1 ? "" : "s"} before it` : "; each occurrence has a deadline on its date";
  }
  return {
    summary,
    frequency: unit,
    interval: rr.fa,
    mode: afterCompletion ? "after-completion" : "fixed",
    endsOn,
    count,
    hasDeadline,
    startsDaysBeforeDeadline,
  };
}

// Building a repeat rule for a new template. Equal in output to things-reminders-sync's
// ThingsRepeat.rr(for:start:), and limited to the shapes its docs/RECURRENCE.md samples from the
// Things app. Anything else is refused: a rule the apps did not write themselves can crash them.
const REPEAT_SUPPORTED =
  "Supported repeats: daily; weekly on chosen weekdays; monthly on day(s) of the month, on the last day, or on the 1st to 4th or last weekday; " +
  "yearly on a date or on the 1st to 4th weekday of a month; each every 1 to 999 units, ending never, on a date, or after N times; " +
  "and after completion every N days with no end.";
const REPEAT_INPUT_KEYS = ["frequency", "interval", "weekdays", "month_days", "nth_weekday", "month", "day", "starts", "ends", "after_completion"];
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const unsupported = (what) => new Error(`${what} ${REPEAT_SUPPORTED}`);

function nameIndex(names, value, what) {
  const s = String(value).trim().toLowerCase();
  const i = names.findIndex((n) => n.toLowerCase() === s || (s.length === 3 && n.toLowerCase().startsWith(s)));
  if (i < 0) throw new Error(`Unknown ${what} "${value}". Use one of ${names.map((n) => n.slice(0, 3).toLowerCase()).join(", ")}.`);
  return i;
}

function nthWeekdayOffset(value, { allowLast }) {
  if (!isPlainObject(value) || !sameKeys(value, ["nth", "weekday"])) throw new Error('repeat.nth_weekday must be {nth, weekday}, for example {nth: 2, weekday: "tue"}.');
  const last = value.nth === "last" || value.nth === -1;
  if (last && !allowLast) throw unsupported("A yearly repeat on the last weekday of a month is not supported.");
  if (!last && !inRange(value.nth, 1, 4)) throw unsupported(`repeat.nth_weekday.nth must be 1 to 4${allowLast ? ' or "last"' : ""}.`);
  return { wdo: last ? -1 : value.nth, wd: nameIndex(WEEKDAYS, value.weekday, "weekday") };
}

// The validated pieces of a `repeat` input: unit code, interval, offsets, mode, and end.
function parseRepeat(repeat) {
  if (!isPlainObject(repeat)) throw new Error("repeat must be an object with at least a frequency.");
  const extra = Object.keys(repeat).filter((k) => !REPEAT_INPUT_KEYS.includes(k));
  if (extra.length) throw unsupported(`Unknown repeat option${extra.length > 1 ? "s" : ""} ${extra.map((k) => `"${k}"`).join(", ")}.`);
  const has = (key) => repeat[key] !== undefined && repeat[key] !== null;
  const fu = { daily: 16, weekly: 256, monthly: 8, yearly: 4 }[repeat.frequency];
  if (!fu) throw unsupported(`repeat.frequency "${repeat.frequency}" is not daily, weekly, monthly, or yearly.`);
  const unit = repeat.frequency;
  const fa = has("interval") ? repeat.interval : 1;
  if (!inRange(fa, 1, 999)) throw new Error("repeat.interval must be a whole number from 1 to 999.");
  const only = (...keys) => {
    const stray = ["weekdays", "month_days", "nth_weekday", "month", "day"].filter((k) => has(k) && !keys.includes(k));
    if (stray.length) throw unsupported(`repeat.${stray[0]} does not apply to a ${unit} repeat${repeat.after_completion === true ? " after completion" : ""}.`);
  };

  let ends = null;
  if (has("ends")) {
    const e = repeat.ends;
    if (!isPlainObject(e) || Object.keys(e).length !== 1 || !("on" in e || "after" in e)) throw new Error('repeat.ends must be {on: "YYYY-MM-DD"} or {after: N}.');
    if ("on" in e) {
      if (!isDateString(e.on)) throw new Error('repeat.ends.on must be a date "YYYY-MM-DD".');
      ends = { on: dateToTimestamp(e.on) };
    } else {
      if (!inRange(e.after, 1, 999)) throw new Error("repeat.ends.after must be a whole number from 1 to 999.");
      ends = { after: e.after };
    }
  }

  if (has("after_completion") && typeof repeat.after_completion !== "boolean") throw new Error("repeat.after_completion must be true or false.");
  if (repeat.after_completion === true) {
    if (unit !== "daily") throw unsupported(`An after-completion repeat every ${fa} ${unit.replace(/ly$/, "")}(s) is not supported.`);
    only();
    if (ends) throw unsupported("An after-completion repeat with an end is not supported.");
    return { unit, fu, fa, of: [], afterCompletion: true, ends: null };
  }

  let of;
  if (unit === "daily") {
    only();
    of = [{ dy: 0 }];
  } else if (unit === "weekly") {
    only("weekdays");
    if (!Array.isArray(repeat.weekdays) || !repeat.weekdays.length) throw new Error('A weekly repeat needs repeat.weekdays, for example ["mon", "thu"].');
    of = [...new Set(repeat.weekdays.map((d) => nameIndex(WEEKDAYS, d, "weekday")))].sort((a, b) => a - b).map((wd) => ({ wd }));
  } else if (unit === "monthly") {
    only("month_days", "nth_weekday");
    if (has("month_days") === has("nth_weekday")) throw new Error('A monthly repeat needs exactly one of repeat.month_days (for example [1, 15] or ["last"]) or repeat.nth_weekday.');
    if (has("nth_weekday")) of = [nthWeekdayOffset(repeat.nth_weekday, { allowLast: true })];
    else {
      const days = repeat.month_days;
      if (!Array.isArray(days) || !days.length) throw new Error('repeat.month_days must be a list of days 1 to 31, or ["last"].');
      if (days.includes("last")) {
        if (days.length > 1) throw unsupported('"last" together with numbered days of the month is not supported.');
        of = [{ dy: -1 }];
      } else {
        if (!days.every((d) => inRange(d, 1, 31))) throw new Error('repeat.month_days must be a list of days 1 to 31, or ["last"].');
        of = [...new Set(days)].sort((a, b) => a - b).map((d) => ({ dy: d - 1 }));
      }
    }
  } else {
    only("month", "day", "nth_weekday");
    if (!has("month")) throw new Error("A yearly repeat needs repeat.month (1 to 12 or a month name).");
    const mo = Number.isInteger(repeat.month) ? repeat.month - 1 : nameIndex(MONTHS, repeat.month, "month");
    if (!inRange(mo, 0, 11)) throw new Error("repeat.month must be 1 to 12 or a month name.");
    if (has("day") === has("nth_weekday")) throw new Error("A yearly repeat needs exactly one of repeat.day (day of the month) or repeat.nth_weekday.");
    if (has("nth_weekday")) {
      const { wdo, wd } = nthWeekdayOffset(repeat.nth_weekday, { allowLast: false });
      of = [{ wdo, mo, wd }];
    } else {
      if (repeat.day === "last") throw unsupported("A yearly repeat on the last day of a month is not supported.");
      if (!inRange(repeat.day, 1, DAYS_IN_MONTH[mo])) throw new Error(`repeat.day must be a day of ${MONTHS[mo]} (1 to ${DAYS_IN_MONTH[mo]}).`);
      of = [{ dy: repeat.day - 1, mo }];
    }
  }
  return { unit, fu, fa, of, afterCompletion: false, ends };
}

// The Things `rr` object for a `repeat` input whose first day is `start` (YYYY-MM-DD). Keys are
// written in the order Things writes them.
export function buildRepeatRule(repeat, start) {
  const rule = parseRepeat(repeat);
  if (!isDateString(start)) throw new Error('A repeat needs a start date "YYYY-MM-DD".');
  const sr = dateToTimestamp(start);
  if (rule.ends?.on !== undefined && rule.ends.on < sr) throw new Error(`repeat.ends.on ${timestampToDate(rule.ends.on)} is before the first day ${start}.`);
  const rc = rule.ends?.after ?? 0;
  const rr = { fu: rule.fu, fa: rule.fa, of: rule.of, tp: rule.afterCompletion ? 1 : 0, ia: rule.afterCompletion ? 0 : sr, sr, rc, ts: 0, rrv: 4 };
  if (rc === 0) rr.ed = rule.ends?.on ?? RR_FAR_FUTURE;
  const problems = repeatRuleProblems(rr);
  if (problems.length) throw new Error(`Refusing to build a repeat rule Things did not write itself: ${problems.join("; ")}`);
  return rr;
}

// Whether the rule's offsets fall on `date`. The interval is counted from the first day, so it
// plays no part in choosing that day.
function repeatMatchesDay(rule, date) {
  if (rule.afterCompletion || rule.unit === "daily") return true;
  const d = new Date(dateToTimestamp(date) * 1000);
  const [year, month, day, weekday] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCDay()];
  const monthLength = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return rule.of.some((e) => {
    if ("mo" in e && e.mo !== month) return false;
    if ("wd" in e && e.wd !== weekday) return false;
    if ("wdo" in e) return e.wdo === -1 ? day + 7 > monthLength : Math.ceil(day / 7) === e.wdo;
    if ("dy" in e) return e.dy === -1 ? day === monthLength : e.dy === day - 1;
    return true;
  });
}

// The first day on or after `from` (YYYY-MM-DD) that the rule falls on.
export function firstRepeatDay(repeat, from) {
  const rule = parseRepeat(repeat);
  // Nine years covers the longest gap, February 29 across a century year that is not a leap year.
  for (let i = 0, day = from; i < 3290; i += 1, day = addDays(day, 1)) if (repeatMatchesDay(rule, day)) return day;
  throw new Error("The repeat rule has no matching day.");
}

// The first day of a new repeating to-do: `starts` when given, otherwise the next matching day.
// A start in the past or on a day the rule skips is refused instead of moved.
export function repeatStartDay(repeat, starts, today) {
  if (starts === undefined || starts === null) return firstRepeatDay(repeat, today);
  if (!isDateString(starts)) throw new Error('repeat.starts must be a date "YYYY-MM-DD".');
  dateToTimestamp(starts);
  if (starts < today) throw new Error(`A repeat cannot start in the past (${starts}). The next day this rule falls on is ${firstRepeatDay(repeat, today)}.`);
  const next = firstRepeatDay(repeat, starts);
  if (next !== starts) throw new Error(`${starts} is not a day this repeat falls on. The next one is ${next}; start there or leave the start out.`);
  return starts;
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
    // A lone surrogate is not valid UTF-8; Things cannot decode the text it ends up in.
    if (illFormed(p.tt)) add("tt contains a lone surrogate");
    if (illFormed(p.nt?.v)) add("nt.v contains a lone surrogate");
    if (illFormed(p.sh)) add("sh contains a lone surrogate");
    if ("xx" in p && !xxOK(p.xx)) add('xx must be {"_t":"oo","sn":{}}');
    if ("ix" in p && !isNum(p.ix)) add("ix must be a finite number");
    if ("ss" in p && ![0, 2, 3].includes(p.ss)) add("ss must be 0, 2, or 3");
    for (const key of ["lt", "tr", "icp"]) if (key in p && typeof p[key] !== "boolean") add(`${key} must be a boolean`);

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
      // A new repeating template: only the shape the Things app writes for one (an open to-do
      // parked at st 2 with no start date, whose tir, icsd, and rr.sr are all the first day).
      if (change.t === 0 && isPlainObject(p.rr)) {
        const fixed = { tp: 0, ss: 0, sp: null, tr: false, st: 2, sb: 0, sr: null, ato: null, dd: null, icc: 0, rp: null, acrd: null };
        for (const [key, want] of Object.entries(fixed)) {
          if (p[key] !== want) add(`a new repeating template needs ${key} ${JSON.stringify(want)}, got ${JSON.stringify(p[key])}`);
        }
        if (!Array.isArray(p.rt) || p.rt.length) add("a new repeating template cannot name templates in rt");
        if (!isNum(p.tir) || p.icsd !== p.tir || p.rr.sr !== p.tir) add("a new repeating template needs tir, icsd, and rr.sr on the same first day");
      }
      if (isStopCreate(change)) {
        for (const [key, want] of Object.entries(STOP_CREATE_FIXED)) {
          if (p[key] !== want) add(`the to-do created when a repeat is stopped needs ${key} ${JSON.stringify(want)}, got ${JSON.stringify(p[key])}`);
        }
        for (const key of ["rt", "dl"]) if (!Array.isArray(p[key]) || p[key].length) add(`the to-do created when a repeat is stopped needs an empty ${key}`);
        if (!isNum(p.sr) || p.tir !== p.sr) add("the to-do created when a repeat is stopped needs sr and tir on the same day");
      }
      for (const key of ["pr", "agr", "ar"]) if (Array.isArray(p[key]) && p[key].length > 1) add(`${key} may hold at most one id`);
    } else if (family === "ChecklistItem") {
      if ("ts" in p && !(Array.isArray(p.ts) && p.ts.length === 1)) add("a checklist item needs exactly one parent task in ts");
      if ("sp" in p && "ss" in p && (p.ss === 0) !== (p.sp === null)) add("sp must be null exactly when ss is 0");
      // Stopping a repeat re-creates the template's checklist items for the new to-do with lt true,
      // md null, and the new to-do's cd. No other checklist create looks like that, and the new
      // to-do takes no other kind of item.
      if (change.t === 0) {
        const parent = Array.isArray(p.ts) ? body[p.ts[0]] : undefined;
        const underStop = isStopCreate(parent);
        if ((p.lt === true || p.md === null || underStop) && !(underStop && p.lt === true && p.md === null && p.cd === parent.p.cd)) {
          add("a checklist item created when a repeat is stopped needs lt true, md null, and the cd of the new to-do, which must be created in the same commit; no other checklist create may have lt true or md null");
        }
      }
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
  const tirOf = (task) => (task?.todayRefDate ? dateToTimestamp(task.todayRefDate) : null);
  const stoppedTemplates = Object.entries(body).filter(([id, ch]) => ch.t === 2 && db.tasks.get(id)?.recurrenceRule).map(([id]) => id);
  const stopCreates = Object.values(body).filter(isStopCreate);

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
      if ("pn" in p) {
        // Walk up from the new parent; arriving back at this tag means it would be its own ancestor.
        const seen = new Set();
        for (let up = shadow.tags.get(id)?.parent; up && !seen.has(up); up = shadow.tags.get(up)?.parent) {
          if (up === id) {
            add(`pn would make tag ${id} its own ancestor`);
            break;
          }
          seen.add(up);
        }
      }
      continue;
    }

    // Tasks, projects, and headings.
    const t = shadow.tasks.get(id);
    const before = db.tasks.get(id);
    refMust("pr", (r) => taskOf(r)?.type === 1 && !taskOf(r).trashed, "an existing, untrashed project");
    refMust("agr", (r) => taskOf(r)?.type === 2 && !taskOf(r).trashed, "an existing, untrashed heading");
    refMust("ar", (r) => shadow.areas.has(r), "an existing area");
    refMust("rt", (r) => Boolean(taskOf(r)?.recurrenceRule), "an existing repeating template");

    if (change.t === 0 && isPlainObject(p.rr) && isNum(p.tir) && p.tir < todayTs) add("a new repeating template cannot start before today");
    if (change.t === 1 && before?.recurrenceRule) {
      // The two rule edits sampled from Things. Both keep rr.sr from the old rule and put rr.ia on
      // the template's next day (tir) as it was before the edit. When the new rule falls on that
      // day the edit is md and rr only. When the next day moves, tir and icsd are written too, both
      // on the new day, which is later, not before today, and a day the new rule falls on. Nothing
      // else about a rule may be written.
      const moves = "rr" in p && sameKeys(p, RULE_MOVE_KEYS);
      for (const key of Object.keys(p)) {
        if (!TEMPLATE_SAFE_KEYS.has(key) && !(moves && (key === "tir" || key === "icsd"))) add(`${key} would change a repeating template; edit repeating to-dos in Things`);
      }
      if ("rr" in p) {
        const no = (why) => add(`rr would change a repeating template in a way Things was not seen to write: ${why}`);
        const old = before.recurrenceRule;
        const tir = tirOf(before);
        const fallsOn = (ts) => repeatMatchesDay({ unit: RR_UNITS[p.rr.fu], of: p.rr.of }, timestampToDate(ts));
        if (!moves && !sameKeys(p, ["md", "rr"])) no("a rule edit writes exactly md and rr, or md, rr, tir, and icsd when the next day moves");
        else if (!isPlainObject(p.rr)) no("a rule cannot be cleared by an update");
        else if (before.instanceCreationPaused) no("the template is paused");
        else if (old.tp !== 0 || p.rr.tp !== 0) no("only a fixed-schedule rule can replace a fixed-schedule rule");
        else if (p.rr.sr !== old.sr) no("rr.sr must stay the old rule's sr");
        else if (tir === null || p.rr.ia !== tir) no("rr.ia must be the template's next day (tir) before the edit");
        else if (!moves) {
          if (!fallsOn(tir)) no(`the new rule does not fall on the template's next day ${before.todayRefDate}, and tir and icsd are not moved with it`);
        } else if (!isNum(p.tir) || p.icsd !== p.tir) no("tir and icsd must both be the new next day");
        else if (p.tir <= tir) no(`the next day can only move later than ${before.todayRefDate}`);
        else if (p.tir < todayTs) no("the new next day cannot be before today");
        else if (!fallsOn(p.tir)) no(`the new rule does not fall on the new next day ${timestampToDate(p.tir)}`);
        else if (isNum(p.rr.ed) && p.rr.ed < p.tir) no("the new rule ends before the new next day");
      }
      if ("icp" in p && !sameKeys(p, ["icp", "md"])) add("icp would change a repeating template; pause and resume write exactly icp and md");
    } else if (change.t === 1 && "icp" in p) add("icp applies to repeating templates only");
    if (change.t === 1 && before?.repeatingTemplates?.length) {
      // Stopping a repeat detaches its open occurrences with {rt: []} and nothing else, in the
      // commit that tombstones the template.
      const detach = sameKeys(p, ["rt"]) && Array.isArray(p.rt) && !p.rt.length && !before.trashed && !before.status && before.repeatingTemplates.every((r) => stoppedTemplates.includes(r));
      for (const key of ["rr", "rt", "tp"]) if (key in p && !(key === "rt" && detach)) add(`${key} would change a repeating occurrence; edit repeating to-dos in Things`);
    }
    if (isStopCreate(change)) {
      const template = stoppedTemplates.length === 1 ? db.tasks.get(stoppedTemplates[0]) : null;
      if (!template) add("the to-do created when a repeat is stopped must come with the tombstone of exactly one repeating template");
      else if (tirOf(template) !== p.sr) add("the to-do created when a repeat is stopped must be on the template's next day (tir)");
      else {
        // Its checklist is the template's, item for item and in the template's order.
        const want = db.checklistItemsFor(template.uuid);
        const got = Object.values(body)
          .filter((c) => c.t === 0 && entityFamily(c.e) === "ChecklistItem" && c.p.ts?.[0] === id)
          .sort((x, y) => x.p.ix - y.p.ix);
        const same = got.length === want.length && want.every((c, i) => got[i].p.ix === i && got[i].p.tt === (c.title ?? "") && got[i].p.ss === (c.status ?? 0) && got[i].p.sp === (c.stopDate ?? null));
        if (!same) add("the to-do created when a repeat is stopped must get the template's checklist items, each with its title, ss, and sp, and ix counting from 0 in the template's order");
      }
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

    // A new open to-do in a completed or canceled project (directly or under one of its headings)
    // would be hidden in the Logbook with it. Finished work can still be filed there: a to-do
    // created completed or canceled is allowed. The to-do a stopped repeat leaves behind takes the
    // template's place and is not a new filing.
    if (change.t === 0 && t.type === 0 && !t.status && !t.recurrenceRule && !isStopCreate(change)) {
      const container = taskOf(shadow.projectIdOf(t));
      if (container?.type === 1 && (container.status === 3 || container.status === 2)) {
        const state = container.status === 3 ? "completed" : "canceled";
        add(`project "${container.title || "Untitled"}" (${container.uuid}) is ${state}, so a new open to-do cannot be filed into it${t.heading ? " or under its headings" : ""}. Reopen the project, choose another one, or create the to-do as completed or canceled`);
      }
    }

    if (["st", "sr", "tp"].some((k) => k in p) && !t.recurrenceRule && typeof t.start === "number") {
      const sr = t.startDate ? dateToTimestamp(t.startDate) : null;
      if (t.type === 2 && t.start !== 1) add("a heading must have st 1");
      if (sr !== null && sr > todayTs && t.start !== 2) add(`start date ${t.startDate} is in the future, so st must be 2 (got ${t.start})`);
      if (sr !== null && sr <= todayTs && t.start === 2) add(`st 2 (someday) with start date ${t.startDate}, which is today or past, is inconsistent`);
      if (t.start === 0 && sr !== null) add("an Inbox to-do (st 0) cannot have a start date");
    }
    if (["st", "tp"].some((k) => k in p) && t.type === 1 && t.start === 0) add("a project cannot be in the Inbox (st 0)");
    if (("ato" in p || "sr" in p) && t.reminderSeconds !== null && t.reminderSeconds !== undefined && !t.startDate && !t.recurrenceRule) {
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
      // Stopping a repeat detaches the open occurrences only; completed, canceled, and trashed
      // ones keep naming the tombstoned template.
      if (!(stopCreates.length && (t.trashed || t.status))) dangling(t.uuid, "repeat template", t.repeatingTemplates);
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
  if (ato === 0) throw new Error("A reminder at 00:00 cannot be stored (Things reads 0 as no reminder). Use 00:01.");
  if (fields.sr === null || fields.sr === undefined) {
    const today = dateToTimestamp(localDate(timeZone));
    return { ...fields, st: 1, sr: today, tir: today, ato };
  }
  return { ...fields, ato };
}

const UNDATED_WHEN = ["inbox", "anytime", "someday"];
const REMINDER_NEEDS_DATE = (when) => `A reminder needs a date, and "${when}" has none. Use when: "today" or a YYYY-MM-DD date, or leave the reminder out.`;

const TASK_KINDS = ["to-do", "project", "heading"];
const aKind = (kind) => `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}`;

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

// The hidden template of a new repeating to-do, with the fields the Things app writes for one:
// parked at st 2 with no start date, tir and icsd on the first day, and the rule in rr. Things
// generates the occurrences from it; none are written here.
export function buildRepeatingTaskCreate({ repeat, start, ...task }) {
  const rr = buildRepeatRule(repeat, start);
  const change = buildTaskCreate({ ...task, when: "someday", reminderTime: null, deadline: null, status: 0 });
  Object.assign(change.p, { tir: rr.sr, icsd: rr.sr, rr });
  return change;
}

// The plain to-do Things creates for the next day when a repeat is stopped (Items > Repeat > Stop,
// sampled from Things 3.24.2). Every value is the sampled one except title, notes, tags, container,
// and ix, which come from the template, cd, and the day. Keys are in the order Things wrote them.
// The second sample (a template with notes and a tag) shows nt and tg copied from the template.
export function buildRepeatStopCreate({ title, notes = "", tags = [], project = null, heading = null, area = null, index = 0, day, now = toUnixTimestamp() }) {
  return {
    t: 0,
    e: ENTITY.task,
    p: {
      tp: 0,
      sr: day,
      dds: null,
      rt: [],
      rmd: null,
      ss: 0,
      tr: false,
      dl: [],
      icp: false,
      st: 2,
      ar: area ? [area] : [],
      tt: title,
      do: 0,
      lai: null,
      tir: day,
      tg: tags,
      agr: heading ? [heading] : [],
      ix: index,
      cd: now,
      lt: true,
      icc: 0,
      ti: 0,
      md: null,
      dd: null,
      ato: null,
      nt: noteObject(notes),
      icsd: null,
      pr: project ? [project] : [],
      rp: null,
      acrd: null,
      sp: null,
      sb: 0,
      rr: null,
      xx: EMPTY_XX(),
    },
  };
}

// A template's checklist item re-created for the to-do a stopped repeat leaves behind (sampled from
// Things 3.24.2): lt true, md null, cd the new to-do's cd, status and stop date carried over.
export function buildRepeatStopChecklistCreate({ title, task, index, status = 0, stopDate = null, now }) {
  return {
    t: 0,
    e: ENTITY.checklist,
    p: { ix: index, cd: now, ts: [task], sp: stopDate, ss: status, xx: EMPTY_XX(), tt: title, md: null, lt: true },
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

// The fields each batch operation writes. A field the operation would not write is refused by
// name: answering "updated" for a deadline that was never set would be a silent drop.
const BATCH_FIELDS = {
  "to-do": {
    complete: ["completion_date"],
    cancel: ["completion_date"],
    trash: [],
    reschedule: ["when"],
    set_dates: ["deadline", "completion_date", "creation_date"],
  },
  project: {
    complete: ["completion_date"],
    cancel: ["completion_date"],
    trash: [],
    reschedule: ["when"],
    set_area: ["area"],
    set_dates: ["when", "area", "deadline", "completion_date", "creation_date"],
  },
};
const BATCH_OPTION_NAMES = { when: "when", area: "area", deadline: "deadline", completionDate: "completion_date", completion_date: "completion_date", creationDate: "creation_date", creation_date: "creation_date" };

// Checks the options of a batch against its operation and returns them under the names the patch
// builder uses. Absent, null, and "" count as not given.
function batchOptions(kind, operation, options) {
  const allowed = BATCH_FIELDS[kind][operation];
  if (!allowed) throw new Error(`Unknown ${kind} batch operation "${operation}"; use one of ${Object.keys(BATCH_FIELDS[kind]).join(", ")}. Nothing was written.`);
  const given = {};
  const unused = new Set();
  for (const [key, value] of Object.entries(options || {})) {
    if (value === undefined || value === null || value === "") continue;
    const name = BATCH_OPTION_NAMES[key] || key;
    if (!allowed.includes(name)) unused.add(name);
    else given[name] = value;
  }
  if (unused.size) {
    const takes = allowed.length ? `it takes ${allowed.map((f) => `"${f}"`).join(", ")}` : "it takes no other fields";
    throw new Error(`Operation "${operation}" on a ${kind} batch does not use ${[...unused].map((f) => `"${f}"`).join(", ")}; ${takes}. Nothing was written.`);
  }
  return { when: given.when, area: given.area, deadline: given.deadline, completionDate: given.completion_date, creationDate: given.creation_date };
}

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

  // Single-escaped, as the Swift client does; which form Things Cloud itself wants is unverified.
  static encodePassword(rawPassword) {
    return encodeURIComponent(rawPassword).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
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
  // after `ancestor` and looks for every key of the body. An update only counts when its
  // properties are the ones we sent (md is unique per commit), so another client's edit to the same
  // item in that window is not mistaken for ours. Returns true, false, or null when the history
  // cannot be read either.
  async commitLanded(body, ancestor) {
    try {
      const head = (await this.getHistoryMetadata()).latestServerIndex;
      const seen = new Set();
      for (const itemMap of await this.pullRange(ancestor, head)) {
        for (const [id, ch] of Object.entries(body)) {
          const got = itemMap[id];
          if (got?.t === ch.t && (ch.t !== 1 || sameJson(got.p, ch.p))) seen.add(id);
        }
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
  //
  // `changes` is a list of change maps, or a builder `(db) => list`. A list is a plain patch: it is
  // resent as it is after a conflict. A builder is for anything computed from the database (a full
  // tg array, a checklist index, a cascade): it runs against the synced database, and again
  // against the refreshed one before every resend, so a retry never writes values derived from
  // state another client has since changed. A builder must mint its ids and timestamps outside
  // itself, so every run names the same new items. It may return [] when nothing is left to write.
  async commitChanges(changes) {
    const build = typeof changes === "function" ? changes : null;
    const merge = (list) => {
      const merged = {};
      for (const change of list || []) Object.assign(merged, change);
      return merged;
    };
    let body = build ? null : merge(changes);
    if (body && !Object.keys(body).length) return { serverHeadIndex: null };

    await this.ensureHistoryKey();
    let db = await this.syncDatabase();
    if (build) body = merge(build(db));
    if (!Object.keys(body).length) return { serverHeadIndex: null };
    validateChangeMap(body, db);
    let payload = JSON.stringify(body);
    let ancestor = db.latestServerIndex;

    // After a 409/412 or a verified miss, re-read the head, rebuild what was derived from the old
    // state, and re-validate against the fresh state.
    const refresh = async () => {
      this.invalidateCache();
      db = await this.syncDatabase({ force: true });
      if (build) {
        try {
          body = merge(build(db));
        } catch (err) {
          throw new Error(`${err.message} (Things changed while this was being written; nothing was written.)`);
        }
        payload = JSON.stringify(body);
      }
      validateChangeMap(body, db);
      ancestor = db.latestServerIndex;
    };

    for (let attempt = 0; ; attempt++) {
      // A rebuild can find that another client already did the work.
      if (!Object.keys(body).length) return { serverHeadIndex: null };
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
    repeat = null,
  }) {
    const db = await this.syncDatabase();
    const taskUUID = generateUUID();
    const now = toUnixTimestamp();
    // A repeating to-do is a template. Its first day comes from repeat.starts (or a dated "when"),
    // defaulting to the next day the rule falls on; everything a template cannot carry is refused.
    let repeatStart = null;
    if (repeat !== null && repeat !== undefined) {
      const not = (what) => new Error(`A repeating to-do cannot be created with ${what}. Create it without, or set that on each occurrence in Things.`);
      if (reminderTime) throw not("a reminder time");
      if (deadline) throw not("a deadline");
      if (completed === true || canceled === true || status !== 0 || completionDate) throw not("a completed or canceled status");
      const today = db.today();
      let starts = isPlainObject(repeat) ? repeat.starts : undefined;
      if (when !== undefined && when !== null) {
        const whenDay = when === "today" ? today : when === "tomorrow" ? addDays(today, 1) : isDateString(when) ? when : null;
        if (!whenDay) throw new Error(`A repeating to-do cannot be scheduled for "${when}". Leave "when" out, or give the first day as a date in "when" or repeat.starts.`);
        if (starts !== undefined && starts !== null && starts !== whenDay) throw new Error(`"when" (${whenDay}) and repeat.starts (${starts}) name different first days. Give one of them.`);
        starts = whenDay;
      }
      repeatStart = repeatStartDay(repeat, starts, today);
    }
    // A reminder needs a date: with no "when" it goes on today, and an undated list is refused.
    if (reminderTime && UNDATED_WHEN.includes(when)) throw new Error(REMINDER_NEEDS_DATE(when));
    // A to-do in a project, heading, or area cannot sit in the Inbox; default to Anytime there.
    if (when === undefined || when === null) when = reminderTime ? "today" : project || heading || area ? "anytime" : "inbox";
    const projectId = project ? db.resolveRef("project", project) : null;
    // With a project given, the heading must be one of that project's headings.
    const headingId = heading ? (projectId ? db.resolveHeadingIn(projectId, heading) : db.resolveRef("heading", heading)) : null;

    let ss = status;
    if (completed === true) ss = 3;
    else if (canceled === true) ss = 2;

    const fields = {
      title,
      notes,
      when,
      reminderTime,
      deadline,
      project: projectId,
      heading: headingId,
      area: area ? db.resolveRef("area", area) : null,
      tags: this.resolveTagIds(db, tags),
      status: ss,
      completionDate,
      creationDate,
      now,
      timeZone: this.timeZone,
    };
    const change = repeatStart ? buildRepeatingTaskCreate({ ...fields, repeat, start: repeatStart }) : buildTaskCreate(fields);
    const changes = [{ [taskUUID]: change }];

    (checklist || []).forEach((item, idx) => {
      changes.push({
        [generateUUID()]: buildChecklistCreate({
          title: typeof item === "string" ? item : item.title,
          task: taskUUID,
          index: idx,
          status: typeof item === "object" && [2, 3].includes(item.status) ? item.status : 0,
          now,
        }),
      });
    });

    await this.commitChanges(changes);
    if (repeatStart) {
      return {
        id: taskUUID,
        title,
        when: "repeating",
        status: "open",
        deadline: null,
        reminderTime: null,
        repeating: true,
        repeatRule: describeRepeatRule(change.p.rr).summary,
        firstOccurrence: repeatStart,
      };
    }
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

    if (updates.when !== undefined) {
      const sched = schedulingFields(updates.when, this.timeZone);
      Object.assign(p, sched);
      // A dated move keeps the reminder time. Inbox, Anytime, and Someday have no date, so the
      // reminder is cleared with it (as the Things Reminders Sync writer does).
      if (sched.sr === null) p.ato = null;
    }

    const reminderTime = [updates.reminderTime, updates["reminder-time"], updates.reminder].find((v) => v !== undefined);
    if (reminderTime !== undefined) {
      if (reminderTime && updates.when !== undefined && p.sr === null) throw new Error(REMINDER_NEEDS_DATE(updates.when));
      const existingSr = p.sr !== undefined ? p.sr : existing?.startDate ? dateToTimestamp(existing.startDate) : null;
      Object.assign(p, withReminder({ st: p.st ?? 1, sb: p.sb ?? 0, sr: existingSr, tir: p.tir ?? null }, reminderTime, this.timeZone));
      if (updates.when === undefined) {
        if (existingSr === null && reminderTime) {
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

    // Containers: null or "" clears; a heading implies its project. When a project (or a list that
    // is a project) comes with a heading, the heading must be one of that project's headings and
    // the to-do is filed under it.
    const headingRef = updates.heading ?? updates["heading-id"];
    const listRef = updates.list ?? updates["list-id"];
    const list = listRef ? db.resolveListRef(listRef) : null;
    const projectId = updates.project ? db.resolveRef("project", updates.project) : list?.type === "project" ? list.id : null;
    const headingId = headingRef ? (projectId ? db.resolveHeadingIn(projectId, headingRef) : db.resolveRef("heading", headingRef)) : null;

    if (updates.heading !== undefined || updates["heading-id"] !== undefined) {
      p.agr = headingId ? [headingId] : [];
      if (headingId) Object.assign(p, { pr: [], ar: [] });
    }
    if (updates.project !== undefined && !headingId) {
      p.pr = projectId ? [projectId] : [];
      p.agr = [];
      if (projectId) p.ar = [];
    }
    if ((updates.list !== undefined || updates["list-id"] !== undefined) && !headingId) {
      p.pr = list?.type === "project" ? [list.id] : [];
      p.ar = list?.type === "area" ? [list.id] : [];
      p.agr = [];
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
    if (updates["add-tags"]) p.tg = [...new Set([...(p.tg ?? existing?.tags ?? []), ...this.resolveTagIds(db, updates["add-tags"])])];
    if (updates.trashed !== undefined) p.tr = Boolean(updates.trashed);
    if (updates.type !== undefined) p.tp = updates.type;

    // Moving an Inbox to-do into a project, heading, or area takes it out of the Inbox.
    const movedIn = [p.pr, p.agr, p.ar].some((ids) => ids && ids.length);
    if (movedIn && p.st === undefined && existing?.type === 0 && existing.start === 0) Object.assign(p, { st: 1, sb: 0 });

    return p;
  }

  // The to-do, project, and heading tools each accept only their own kind of item: a project or
  // heading id given to a to-do tool (or the reverse) is refused, never written.
  requireKind(db, uuid, type) {
    const wanted = TASK_KINDS[type];
    const t = db.tasks.get(uuid);
    if (t?.type === type) return t;
    const actual = db.kindOf(uuid);
    if (!actual) throw new Error(`No ${wanted} with id ${uuid}.`);
    const hint = t ? ` Use the ${actual} tools for it.` : "";
    throw new Error(`${uuid} is ${aKind(actual)}, not a ${wanted}; nothing was changed.${hint}`);
  }

  // Completing or canceling a project closes its open to-dos in the same commit, as the Things
  // app does: each open, untrashed to-do in the project or under its headings gets the status
  // write of a single to-do (md, ss, sp) with the project's own timestamps. To-dos already
  // completed, canceled, or trashed, headings, and repeating templates are left alone. Returns []
  // when `patch` does not close the project; reopening a project reopens nothing.
  projectCloseChanges(db, projectId, patch) {
    if (patch.ss !== 3 && patch.ss !== 2) return [];
    return [...db.tasks.values()]
      .filter((t) => t.type === 0 && !t.status && db.isLive(t) && db.projectIdOf(t) === projectId && !db.inTrashedContainer(t))
      .map((t) => ({ [t.uuid]: { t: 1, e: ENTITY.task, p: { md: patch.md, ss: patch.ss, sp: patch.sp } } }));
  }

  // The patch can depend on the item as it is (appended notes, a kept reminder, the open to-dos
  // of a project being closed), so it is built inside the commit and rebuilt after a conflict.
  async updateTask(uuid, updates, type) {
    const now = toUnixTimestamp();
    let patch;
    let closed;
    await this.commitChanges((db) => {
      this.requireKind(db, uuid, type);
      patch = this.buildTaskPatch(db, { ...updates, __uuid: uuid }, now);
      closed = type === 1 ? this.projectCloseChanges(db, uuid, patch) : [];
      return [{ [uuid]: { t: 1, e: ENTITY.task, p: patch } }, ...closed];
    });
    const closing = type === 1 && (patch.ss === 3 || patch.ss === 2);
    return { id: uuid, updated: true, ...(closing ? { todosClosed: closed.length } : {}) };
  }

  async updateTodo(uuid, updates = {}) {
    return this.updateTask(uuid, updates, 0);
  }

  async trashTodo(uuid) {
    return this.updateTodo(uuid, { trashed: true });
  }

  // Edit, pause, resume, or stop the repeat of a to-do. `id` is the template or one of its
  // occurrences. Each action writes exactly what Things 3.24.2 was sampled writing for it
  // (2026-11-09), and anything that would need a shape that was not sampled is refused.
  async updateRepeat(id, { action, repeat = null } = {}) {
    if (!["rule", "pause", "resume", "stop"].includes(action)) throw new Error('action must be "rule", "pause", "resume", or "stop".');
    const hasRepeat = repeat !== null && repeat !== undefined;
    if (action === "rule" && !hasRepeat) throw new Error('The "rule" action needs a repeat object with the new rule.');
    if (action !== "rule" && hasRepeat) throw new Error(`"repeat" goes with the "rule" action only, not "${action}"; nothing was changed.`);

    // Everything below is decided from the template as it is now, so it is planned inside the
    // commit and planned again from the refreshed database after a conflict.
    const now = toUnixTimestamp();
    // One ordered pool of new ids, so a plan rebuilt after a conflict names the same new items.
    const ids = [];
    let plan;
    await this.commitChanges((db) => {
      let n = 0;
      plan = this.planRepeatUpdate(db, id, { action, repeat }, now, () => (ids[n] ??= generateUUID(), ids[n++]));
      return plan.changes;
    });
    return plan.result;
  }

  // The changes and the tool result for one things_update_repeat call against `db`. `mintId`
  // returns the ids of the items a stop creates, in order.
  planRepeatUpdate(db, id, { action, repeat }, now, mintId) {
    const given = this.requireKind(db, id, 0);
    let template = given;
    if (!given.recurrenceRule) {
      const templateId = given.repeatingTemplates?.[0];
      if (!templateId) throw new Error(`${id} is not a repeating to-do or one of its occurrences; nothing was changed.`);
      template = db.tasks.get(templateId);
      if (!template?.recurrenceRule) throw new Error(`The repeating template ${templateId} of ${id} no longer exists (its repeat was stopped); nothing was changed.`);
    }
    const tid = template.uuid;
    const base = { id: tid, title: template.title, action };
    if (template.trashed) throw new Error(`The repeating to-do ${tid} is in the Trash; restore it first. Nothing was changed.`);
    const paused = Boolean(template.instanceCreationPaused);
    const nextDay = template.todayRefDate || null;
    const today = db.today();

    if (action === "pause" || action === "resume") {
      const want = action === "pause";
      if (paused === want) return { changes: [], result: { ...base, changed: false, paused } };
      return { changes: [{ [tid]: { t: 1, e: ENTITY.task, p: { icp: want, md: now } } }], result: { ...base, changed: true, paused: want } };
    }

    if (action === "rule") {
      const inThings = "Edit this rule in Things. Nothing was changed.";
      const old = template.recurrenceRule;
      if (repeatRuleProblems(old).length || old.tp !== 0) throw new Error(`The current rule of ${tid} is not a plain fixed-schedule rule (it repeats after completion, has a deadline offset, or is a shape this connector does not know). ${inThings}`);
      if (isPlainObject(repeat) && repeat.after_completion === true) throw new Error(`Changing a rule to repeat after completion was not sampled from Things. ${inThings}`);
      if (paused) throw new Error(`The repeating to-do ${tid} is paused, and editing the rule of a paused repeat was not sampled from Things. Resume it first (action "resume"), then edit the rule. Nothing was changed.`);
      if (!nextDay) throw new Error(`The repeating to-do ${tid} has no next day. ${inThings}`);
      const rule = parseRepeat(repeat);
      const starts = repeat.starts;
      const hasStarts = starts !== undefined && starts !== null;
      let newDay = nextDay;
      if (hasStarts ? starts !== nextDay : !repeatMatchesDay(rule, nextDay)) {
        // The next day moves: to repeat.starts, or to the first day the new rule falls on, counted
        // from the current next day and never from before today.
        if (!hasStarts) newDay = firstRepeatDay(repeat, nextDay < today ? today : nextDay);
        else {
          if (!isDateString(starts)) throw new Error('repeat.starts must be a date "YYYY-MM-DD". Nothing was changed.');
          dateToTimestamp(starts);
          if (starts < nextDay) throw new Error(`repeat.starts (${starts}) is before the next day of this repeat (${nextDay}). An edit that moves the next day earlier was not sampled from Things. ${inThings}`);
          if (starts < today) throw new Error(`repeat.starts (${starts}) is in the past; the next day of a repeat cannot move to before today (${today}). Nothing was changed.`);
          newDay = starts;
        }
      }
      if (!repeatMatchesDay(rule, newDay)) {
        throw new Error(`${newDay} is not a day the new rule falls on. The next one is ${firstRepeatDay(repeat, newDay < today ? today : newDay)}; give that as repeat.starts or leave repeat.starts out. Nothing was changed.`);
      }
      // The builder's rule for a first day of nextDay (so ia is the next day before the edit), with
      // the old rule's sr.
      const rr = { ...buildRepeatRule(repeat, nextDay), sr: old.sr };
      const moved = newDay !== nextDay;
      const day = dateToTimestamp(newDay);
      if (moved && isNum(rr.ed) && rr.ed < day) throw new Error(`repeat.ends.on ${timestampToDate(rr.ed)} is before the new next day ${newDay}. Nothing was changed.`);
      return {
        changes: [{ [tid]: { t: 1, e: ENTITY.task, p: moved ? { rr, md: now, icsd: day, tir: day } : { md: now, rr } } }],
        result: { ...base, changed: true, repeatRule: describeRepeatRule(rr).summary, nextOccurrence: newDay, previousNextOccurrence: nextDay, nextDayMoved: moved },
      };
    }

    // stop
    const trashInstead = `Trashing the template (things_delete_todo with id ${tid}) also ends the repeat. Nothing was changed.`;
    if (paused) throw new Error(`The repeating to-do ${tid} is paused, and stopping a paused repeat was not sampled from Things. Resume it first (action "resume"), then stop it. ${trashInstead}`);
    if (template.deadlineSentinel || (template.reminderSeconds !== null && template.reminderSeconds !== undefined)) {
      throw new Error(`The repeating to-do ${tid} adds deadlines or reminders, and stopping such a repeat was not sampled from Things. Stop it in Things. ${trashInstead}`);
    }
    if (!nextDay || nextDay <= today) {
      throw new Error(`The next day of the repeating to-do ${tid} is ${nextDay || "not set"}; only a repeat whose next day is in the future can be stopped here (the sampled case). Open Things so it creates the due occurrence, then stop again. ${trashInstead}`);
    }
    const newId = mintId();
    const create = buildRepeatStopCreate({
      title: template.title,
      notes: template.notes || "",
      tags: [...(template.tags || [])],
      project: template.project || null,
      heading: template.heading || null,
      area: template.area || null,
      index: template.index ?? 0,
      day: dateToTimestamp(nextDay),
      now,
    });
    const open = [...db.tasks.values()].filter((t) => t.repeatingTemplates?.includes(tid) && !t.trashed && !t.status);
    // The template's checklist items are re-created for the new to-do, in order, and its own are
    // tombstoned with it.
    const items = db.checklistItemsFor(tid);
    const copies = items.map((c, i) => ({
      [mintId()]: buildRepeatStopChecklistCreate({ title: c.title ?? "", task: newId, index: i, status: c.status ?? 0, stopDate: c.stopDate ?? null, now }),
    }));
    return {
      changes: [
        { [newId]: create },
        ...copies,
        ...items.map((c) => ({ [c.uuid]: { t: 2, e: ENTITY.checklist, p: {} } })),
        ...open.map((t) => ({ [t.uuid]: { t: 1, e: ENTITY.task, p: { rt: [] } } })),
        { [tid]: { t: 2, e: ENTITY.task, p: {} } },
      ],
      result: { ...base, changed: true, stopped: true, newTodoId: newId, scheduledDate: nextDay, checklistItemsCopied: items.length, detachedOccurrences: open.map((t) => t.uuid) },
    };
  }

  // Tombstones for `ids` plus everything that would otherwise be left pointing at them: checklist
  // items, headings, and trashed children of a purged project or heading, and tag or area
  // references on items that stay. A trashed project or heading takes all of its contents with it:
  // Things keeps tr false on the to-dos inside a trashed project and removes them together with
  // it when the Trash is emptied. Live children of a project that is not trashed are left alone;
  // the validator then refuses the commit and names them.
  purgeChanges(db, ids, now = toUnixTimestamp()) {
    const purge = new Set(ids);
    const withContents = new Set(ids.filter((id) => db.tasks.get(id)?.trashed));
    for (let grew = true; grew; ) {
      grew = false;
      for (const t of db.tasks.values()) {
        if (purge.has(t.uuid) || !(purge.has(t.project) || purge.has(t.heading))) continue;
        const inTrashed = withContents.has(t.project) || withContents.has(t.heading);
        if (t.type === 2 || t.trashed || inTrashed) {
          purge.add(t.uuid);
          if (t.trashed || inTrashed) withContents.add(t.uuid);
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

  // Permanently remove one item of the named kind ("to-do", "project", "heading", or "checklist
  // item"). An id of any other kind is refused: a parent's id given by mistake must not delete
  // the parent.
  async deleteEntity(uuid, kind) {
    if (kind !== "checklist item" && !TASK_KINDS.includes(kind)) throw new Error(`deleteEntity needs a kind (${TASK_KINDS.join(", ")}, or checklist item).`);
    const now = toUnixTimestamp();
    // The cascade (contents, tag and area references) is read from the database, so it is rebuilt
    // after a conflict.
    await this.commitChanges((db) => {
      if (kind === "checklist item") {
        if (!db.checklists.has(uuid)) {
          const actual = db.kindOf(uuid);
          throw new Error(actual ? `${uuid} is ${aKind(actual)}, not a checklist item; nothing was deleted.` : `No checklist item with id ${uuid}.`);
        }
      } else this.requireKind(db, uuid, TASK_KINDS.indexOf(kind));
      return this.purgeChanges(db, [uuid], now);
    });
    return { id: uuid, deleted: true };
  }

  async deleteTodo(uuid) {
    return this.deleteEntity(uuid, "to-do");
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
    return this.updateTask(uuid, updates, 1);
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
    if (deleted) return this.deleteEntity(uuid, "heading");
    const db = await this.syncDatabase();
    this.requireKind(db, uuid, 2);
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
    const now = toUnixTimestamp();
    // The list of items in the area is read from the database, so it is rebuilt after a conflict.
    await this.commitChanges((db) => {
      if (!db.areas.has(uuid)) throw new Error(`No area with id ${uuid}.`);
      const changes = [];
      // Items always lose the reference to the deleted area; with deleteContents they are trashed too.
      for (const t of db.tasks.values()) {
        if (t.area !== uuid) continue;
        const p = { ar: [], md: now };
        if (deleteContents && !t.trashed) p.tr = true;
        changes.push({ [t.uuid]: { t: 1, e: ENTITY.task, p } });
      }
      changes.push({ [uuid]: { t: 2, e: ENTITY.area, p: {} } });
      return changes;
    });
    return { id: uuid, deleted: true, contentsPurged: deleteContents };
  }

  // Things keeps tag titles unique; a second "work" beside "Work" would make every later write
  // that names the tag ambiguous.
  requireFreeTagTitle(db, title, exceptId = null) {
    const clash = [...db.tags.values()].find((g) => g.uuid !== exceptId && (g.title || "").toLowerCase() === String(title).trim().toLowerCase());
    if (clash) throw new Error(`A tag named "${clash.title}" already exists (${clash.uuid}).`);
  }

  async createTag({ title, shortcut = null, parent = null }) {
    const db = await this.syncDatabase();
    this.requireFreeTagTitle(db, title);
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
    if (title !== undefined) {
      this.requireFreeTagTitle(db, title, uuid);
      p.tt = title;
    }
    if (shortcut !== undefined) p.sh = shortcut || null;
    if (parent !== undefined) p.pn = parent ? [db.resolveRef("tag", parent)] : [];
    await this.commitChanges([{ [uuid]: { t: 1, e: ENTITY.tag, p } }]);
    return { id: uuid, updated: true };
  }

  async deleteTag(uuid) {
    const now = toUnixTimestamp();
    // Removing a tag rewrites the full tg array of every item that carries it, from the database
    // as it is when the commit is sent.
    await this.commitChanges((db) => {
      if (!db.tags.has(uuid)) throw new Error(`No tag with id ${uuid}.`);
      return this.purgeChanges(db, [uuid], now);
    });
    return { id: uuid, deleted: true };
  }

  // --- Checklist items --------------------------------------------------------

  async addChecklistItems(taskUUID, items) {
    const now = toUnixTimestamp();
    const created = items.map((item) => ({ id: generateUUID(), title: typeof item === "string" ? item : item.title, status: "open" }));
    // The new items go after the last one the to-do has when the commit is sent.
    await this.commitChanges((db) => {
      const task = db.tasks.get(taskUUID);
      if (!task || task.type !== 0) throw new Error(`No to-do with id ${taskUUID}.`);
      const first = db.checklistItemsFor(taskUUID).reduce((max, c) => Math.max(max, c.index ?? 0), -1) + 1;
      return created.map(({ id, title }, n) => ({ [id]: buildChecklistCreate({ title, task: taskUUID, index: first + n, now }) }));
    });
    return created;
  }

  async setChecklist(taskUUID, items) {
    const now = toUnixTimestamp();
    const fresh = items.map((item) => {
      let status = 0;
      if (typeof item === "object") {
        if (item.status === "completed" || item.completed === true) status = 3;
        else if (item.status === "canceled" || item.canceled === true) status = 2;
      }
      return { id: generateUUID(), title: typeof item === "string" ? item : item.title || "Untitled", status };
    });
    const created = fresh.map(({ id, title, status }) => ({ id, title, status: status === 3 ? "completed" : status === 2 ? "canceled" : "open" }));

    // Replacing means tombstoning every item the to-do has when the commit is sent, including one
    // another client added a moment ago.
    await this.commitChanges((db) => {
      const task = db.tasks.get(taskUUID);
      if (!task || task.type !== 0) throw new Error(`No to-do with id ${taskUUID}.`);
      return [
        ...db.checklistItemsFor(taskUUID).map((c) => ({ [c.uuid]: { t: 2, e: ENTITY.checklist, p: {} } })),
        ...fresh.map(({ id, title, status }, index) => ({ [id]: buildChecklistCreate({ title, task: taskUUID, index, status, now }) })),
      ];
    });
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
    return this.deleteEntity(uuid, "checklist item");
  }

  // --- Compound operations -----------------------------------------------------

  async duplicateTodo(uuid) {
    const db = await this.syncDatabase();
    const orig = this.requireKind(db, uuid, 0);
    if (orig.recurrenceRule) throw new Error(`${uuid} is a repeating template; duplicate repeating to-dos in Things.`);
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
      checklist: db.checklistItemsFor(uuid).map((c) => ({ title: c.title, status: c.status })),
    });
  }

  async emptyTrash() {
    const now = toUnixTimestamp();
    let seen = null;
    let trashed = [];
    let tasksPurged = [];
    // After a conflict the purge is rebuilt from the refreshed database, and only for items that
    // were in the Trash when the tool was called and still are: something restored in the
    // meantime is kept, and something trashed in the meantime waits for the next call.
    await this.commitChanges((db) => {
      const inTrash = [...db.tasks.values()].filter((t) => t.trashed).map((t) => t.uuid);
      seen ??= new Set(inTrash);
      trashed = inTrash.filter((id) => seen.has(id));
      const changes = trashed.length ? this.purgeChanges(db, trashed, now) : [];
      // Everything tombstoned, checklist items included; containedCount is what went with a trashed
      // project or heading without being marked trashed itself.
      tasksPurged = changes.filter((c) => Object.values(c)[0].t === 2).map((c) => Object.keys(c)[0]).filter((id) => db.tasks.has(id));
      return changes;
    });
    if (!trashed.length) return { purgedCount: 0 };
    return { purgedCount: tasksPurged.length, trashedCount: trashed.length, containedCount: tasksPurged.length - trashed.length };
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
    const now = toUnixTimestamp();
    const todoIds = new Map(); // checklist item id -> id of the to-do it becomes, the same on every build
    let task;
    let checklistItems;
    // The checklist is read from the database, so the conversion is rebuilt after a conflict.
    await this.commitChanges((db) => {
      task = this.requireKind(db, uuid, 0);
      checklistItems = db.checklistItemsFor(uuid);
      const patch = { tp: 1, pr: [], agr: [], md: now };
      // Things has no Inbox projects: a project made from an Inbox to-do goes to Anytime.
      if (task.start === 0) Object.assign(patch, { st: 1, sb: 0 });
      const changes = [{ [uuid]: { t: 1, e: ENTITY.task, p: patch } }];

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
        if (!todoIds.has(item.uuid)) todoIds.set(item.uuid, generateUUID());
        changes.push({ [todoIds.get(item.uuid)]: todo });
        changes.push({ [item.uuid]: { t: 2, e: ENTITY.checklist, p: {} } });
      });
      return changes;
    });
    return { id: uuid, title: task.title, type: "project", tasksCreated: checklistItems.length };
  }

  // Import Things JSON (https://culturedcode.com/things/support/articles/2803573/).
  async importJson(payload) {
    const now = toUnixTimestamp();
    // An import reads the database (titles, appended notes, added tags, checklist indexes, the
    // to-dos of a project it closes), so it is planned inside the commit and planned again after a
    // conflict. New ids are handed out in order from one pool, so every plan names the same items.
    const ids = [];
    let plan;
    await this.commitChanges((db) => {
      let n = 0;
      plan = this.planImport(db, payload, now, () => (ids[n] ??= generateUUID(), ids[n++]));
      return plan.changes;
    });
    return plan.result;
  }

  // The changes and the tool result of one import against `base`. `mint()` returns the next new id.
  planImport(base, payload, now, mint) {
    // Later items resolve titles of earlier ones, so created items are applied to a copy of the
    // cache. A refused or failed commit then leaves the cached database untouched.
    const db = base.clone();
    const items = Array.isArray(payload) ? payload : [payload];
    const changes = [];
    let projectsCreated = 0;
    let todosCreated = 0;
    let projectsUpdated = 0;
    let todosUpdated = 0;
    const itemResults = [];

    const addChecklist = (attrs, todoUUID, items = attrs["checklist-items"] || attrs.checklist || [], firstIndex = 0) => {
      items.forEach((cl, idx) => {
        const title = typeof cl === "string" ? cl : cl.title || cl.attributes?.title;
        const isCompleted = typeof cl === "object" && (cl.completed === true || cl.status === "completed" || cl.attributes?.completed === true);
        const isCanceled = typeof cl === "object" && (cl.canceled === true || cl.status === "canceled" || cl.attributes?.canceled === true);
        const status = isCompleted ? 3 : isCanceled ? 2 : 0;
        changes.push({
          [mint()]: buildChecklistCreate({
            title,
            task: todoUUID,
            index: firstIndex + idx,
            status,
            now,
          }),
        });
      });
    };
    const updated = new Map();

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

        if ("prepend-checklist-items" in attrs) throw new Error(`"prepend-checklist-items" is not supported on updates; use "checklist-items" (replaces) or "append-checklist-items".`);
        const patch = this.buildTaskPatch(db, { ...attrs, __uuid: item.id }, now);
        // A commit holds one change per id, so a second update of the same item joins the first.
        if (updated.has(item.id)) Object.assign(updated.get(item.id), patch);
        else {
          updated.set(item.id, patch);
          changes.push({ [item.id]: { t: 1, e: ENTITY.task, p: patch } });
        }
        db.applyChangeMap({ [item.id]: { t: 1, e: ENTITY.task, p: patch } });
        if (type === "project") projectsUpdated++;
        else todosUpdated++;
        const itemResult = { id: item.id, type, operation: "updated", title: patch.tt || existing.title || "Untitled" };
        itemResults.push(itemResult);
        if (type === "project" && (patch.ss === 3 || patch.ss === 2)) {
          // Closing a project closes its open to-dos. One change per id: a to-do this import
          // already created or updated takes the status in that change.
          const closed = this.projectCloseChanges(db, item.id, patch);
          for (const change of closed) {
            const [childId] = Object.keys(change);
            const pending = changes.find((c) => childId in c);
            if (pending) Object.assign(pending[childId].p, { ss: patch.ss, sp: patch.sp });
            else {
              updated.set(childId, change[childId].p);
              changes.push(change);
            }
            db.applyChangeMap(change);
          }
          itemResult.todosClosed = closed.length;
        }
        // "checklist-items" replaces the checklist, as in Things JSON; "append-checklist-items" adds to it.
        const current = db.checklistItemsFor(item.id);
        if (attrs["checklist-items"] || attrs.checklist) {
          for (const c of current) {
            const tombstone = { [c.uuid]: { t: 2, e: ENTITY.checklist, p: {} } };
            changes.push(tombstone);
            db.applyChangeMap(tombstone);
          }
          addChecklist(attrs, item.id);
        } else if (attrs["append-checklist-items"]) {
          addChecklist(attrs, item.id, attrs["append-checklist-items"], current.reduce((max, c) => Math.max(max, c.index ?? 0), -1) + 1);
        }
      } else if (type === "project") {
        const projectUUID = mint();
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
            headingUUID = mint();
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
            const todoUUID = mint();
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
        const todoUUID = mint();
        let project = null;
        let heading = null;
        let area = null;

        const headingRef = attrs["heading-id"] || attrs.heading;
        const listRef = attrs["list-id"] || attrs.list ? db.resolveListRef(attrs["list-id"] || attrs.list) : null;
        if (headingRef) {
          // With a project list given, the heading must be one of that project's headings.
          heading = listRef?.type === "project" ? db.resolveHeadingIn(listRef.id, headingRef) : db.resolveRef("heading", headingRef);
        } else if (listRef) {
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

    return {
      changes,
      result: {
        projectsCreated,
        todosCreated,
        projectsUpdated,
        todosUpdated,
        totalEntities: changes.length,
        items: itemResults,
      },
    };
  }

  // To-dos and projects carry tags; headings do not.
  taggable(db, uuid) {
    const task = db.tasks.get(uuid);
    if (!task) throw new Error(`Task not found: ${uuid}`);
    if (task.type === 2) throw new Error(`${uuid} is a heading; only to-dos and projects carry tags.`);
    return task;
  }

  // Things stores tags as one full tg array, so adding or removing a tag is a read-modify-write:
  // `tagsFor(db, task)` computes the array from the item as it is when the commit is sent, and
  // again after a conflict, so a tag another client added in between is kept.
  async retagTask(taskUUID, tagsFor) {
    const now = toUnixTimestamp();
    await this.commitChanges((db) => {
      const task = this.taggable(db, taskUUID);
      return [{ [taskUUID]: { t: 1, e: ENTITY.task, p: this.buildTaskPatch(db, { __uuid: taskUUID, tags: tagsFor(db, task) }, now) } }];
    });
    return { id: taskUUID, updated: true };
  }

  async addTagsToTask(taskUUID, tagNames) {
    return this.retagTask(taskUUID, (db, task) => [...new Set([...(task.tags || []), ...this.resolveTagIds(db, tagNames)])]);
  }

  async removeTagsFromTask(taskUUID, tagNames) {
    return this.retagTask(taskUUID, (db, task) => {
      const remove = new Set(this.resolveTagIds(db, tagNames));
      return (task.tags || []).filter((id) => !remove.has(id));
    });
  }

  // One commit: every item lands or none does. The result lists each item so the caller can see
  // exactly what was written; any unknown id refuses the whole batch and names every bad id.
  async batchUpdateTodos(uuids, operation, options = {}) {
    const o = batchOptions("to-do", operation, options);
    if (operation === "reschedule" && !o.when) throw new Error('Operation "reschedule" needs "when".');
    if (operation === "set_dates" && !(o.deadline || o.completionDate || o.creationDate)) {
      throw new Error('Operation "set_dates" needs deadline, completion_date, or creation_date.');
    }
    return this.commitBatch(uuids, operation, "To-do", (db, uuid) => db.tasks.get(uuid)?.type === 0, (db, uuid, now) =>
      this.buildTaskPatch(db, {
        __uuid: uuid,
        status: operation === "complete" ? "completed" : operation === "cancel" ? "canceled" : undefined,
        trashed: operation === "trash" ? true : undefined,
        when: o.when,
        deadline: o.deadline,
        completionDate: o.completionDate,
        creationDate: o.creationDate,
      }, now)
    );
  }

  async batchUpdateProjects(uuids, operation, options = {}) {
    const o = batchOptions("project", operation, options);
    if (operation === "reschedule" && !o.when) throw new Error('Operation "reschedule" needs "when".');
    if (operation === "set_area" && !o.area) throw new Error('Operation "set_area" needs "area".');
    if (operation === "set_dates" && !(o.when || o.area || o.deadline || o.completionDate || o.creationDate)) {
      throw new Error('Operation "set_dates" needs when, deadline, completion_date, or creation_date.');
    }
    const result = await this.commitBatch(uuids, operation, "Project", (db, uuid) => db.tasks.get(uuid)?.type === 1, (db, uuid, now) =>
      this.buildTaskPatch(db, {
        __uuid: uuid,
        status: operation === "complete" ? "completed" : operation === "cancel" ? "canceled" : undefined,
        trashed: operation === "trash" ? true : undefined,
        when: o.when,
        area: o.area,
        deadline: o.deadline,
        completionDate: o.completionDate,
        creationDate: o.creationDate,
      }, now),
      (db, uuid, patch) => this.projectCloseChanges(db, uuid, patch)
    );
    if (operation === "complete" || operation === "cancel") result.todosClosed = result.items.reduce((n, item) => n + item.todosClosed, 0);
    else for (const item of result.items) delete item.todosClosed;
    return result;
  }

  // `alsoFor(db, uuid, patch)` returns further changes that belong in the same commit as that item.
  // The whole batch is built inside the commit, and built again after a conflict, because a patch
  // can depend on the item as it is and a closed project takes its open to-dos with it.
  async commitBatch(uuids, operation, label, exists, patchFor, alsoFor = null) {
    const ids = [...new Set(uuids)];
    const now = toUnixTimestamp();
    let items = [];
    await this.commitChanges((db) => {
      const missing = ids.filter((uuid) => !exists(db, uuid));
      if (missing.length) {
        const named = missing.map((uuid) => (db.kindOf(uuid) ? `${uuid} (${aKind(db.kindOf(uuid))})` : uuid));
        throw new Error(`${label} not found: ${named.join(", ")}. Nothing was written.`);
      }
      const changes = [];
      items = [];
      for (const uuid of ids) {
        const p = patchFor(db, uuid, now);
        changes.push({ [uuid]: { t: 1, e: ENTITY.task, p } });
        const also = alsoFor ? alsoFor(db, uuid, p) : null;
        if (also) changes.push(...also);
        items.push({ id: uuid, title: db.tasks.get(uuid)?.title || null, result: "updated", ...(also ? { todosClosed: also.length } : {}) });
      }
      return changes;
    });
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

  // A copy whose "today" and calendar days are in another time zone, for reading only: Today,
  // Upcoming, deadlines, the Logbook day filters, and the daily summary. Writes always go through
  // the client's own database and its configured zone.
  inTimeZone(timeZone) {
    const copy = this.clone();
    copy.timeZone = assertTimeZone(timeZone);
    return copy;
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
    if ("dd" in p) {
      // A repeating template with "Add deadlines" carries the far-future sentinel, not a real date.
      out.deadlineSentinel = isNum(p.dd) && p.dd >= RR_FAR_FUTURE;
      out.deadline = out.deadlineSentinel ? null : timestampToDate(p.dd);
    }
    if ("dds" in p) out.deadlineSuppressed = p.dds !== null && p.dds !== undefined;
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
    if ("icp" in p) out.instanceCreationPaused = Boolean(p.icp);
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
      heading: [this.tasks, (t) => t.type === 2 && !t.trashed && !this.tasks.get(t.project)?.trashed],
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

  // A heading of one given project, by id or (case-insensitive) title. A heading that exists only
  // in another project is refused, and a title shared with other projects is not ambiguous here.
  resolveHeadingIn(projectId, value) {
    const wanted = String(value).trim();
    const live = (t) => t?.type === 2 && !t.trashed;
    const named = (t) => live(t) && (t.uuid === wanted || (t.title || "").toLowerCase() === wanted.toLowerCase());
    const all = [...this.tasks.values()].filter(named);
    const here = all.filter((t) => t.project === projectId);
    const project = this.tasks.get(projectId)?.title || projectId;
    if (here.length === 1) return here[0].uuid;
    if (here.length > 1) throw new Error(`More than one heading in project "${project}" is named "${wanted}". Use its id instead: ${here.map((h) => h.uuid).join(", ")}.`);
    if (all.length) throw new Error(`Heading "${wanted}" belongs to another project, not "${project}". Nothing was written.`);
    throw new Error(`No heading found for "${wanted}" in project "${project}".`);
  }

  kindOf(uuid) {
    const t = this.tasks.get(uuid);
    if (t) return TASK_KINDS[t.type] || "to-do";
    if (this.checklists.has(uuid)) return "checklist item";
    if (this.areas.has(uuid)) return "area";
    if (this.tags.has(uuid)) return "tag";
    return null;
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
    // A template is the hidden holder of a rule, not a Someday to-do.
    if (t.recurrenceRule) return "repeating";
    if (t.start === 0) return "inbox";
    if (t.start === 2) return t.startDate || "someday";
    if (t.startDate && t.startDate <= this.today()) return t.startBucket === 1 ? "evening" : "today";
    return t.startDate || "anytime";
  }

  formatTask(t) {
    const projectId = this.projectIdOf(t);
    const checklist = this.resolveChecklistItems(t.uuid);

    const template = Boolean(t.recurrenceRule);
    const rule = template ? describeRepeatRule(t.recurrenceRule, { hasDeadline: Boolean(t.deadlineSentinel) }) : null;

    return {
      id: t.uuid,
      title: t.title,
      notes: t.notes || "",
      status: t.status === 3 ? "completed" : t.status === 2 ? "canceled" : "open",
      when: this.whenOf(t),
      scheduledDate: template ? null : t.startDate || null,
      deadline: t.deadline || null,
      // A repeating template: the rule in words, and the day Things will show the next occurrence.
      // An occurrence is an ordinary to-do that names its template.
      repeating: template || undefined,
      repeatRule: rule?.summary,
      // paused: Things creates no occurrences until the repeat is resumed.
      repeat: rule ? { ...rule, nextOccurrence: t.todayRefDate || null, paused: Boolean(t.instanceCreationPaused) } : undefined,
      repeatTemplateId: (!template && t.repeatingTemplates?.[0]) || undefined,
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

  // Things leaves tr false on the contents of a trashed project (or heading); they are in the
  // Trash with it all the same.
  inTrashedContainer(t) {
    const heading = t.heading ? this.tasks.get(t.heading) : null;
    return Boolean(heading?.trashed || this.tasks.get(this.projectIdOf(t))?.trashed);
  }

  // Open to-dos as the Things lists show them: also not inside a trashed, completed, or canceled project.
  getOpenTasks() {
    return [...this.tasks.values()].filter((t) => {
      if (t.type !== 0 || t.status !== 0 || !this.isLive(t) || this.inTrashedContainer(t)) return false;
      const project = this.tasks.get(this.projectIdOf(t));
      return !project || !project.status;
    });
  }

  getInbox() {
    return this.getOpenTasks()
      .filter((t) => t.start === 0)
      .map((t) => this.formatTask(t));
  }

  getToday() {
    const today = this.today();
    // As in the Things app: everything whose start date has arrived, including scheduled to-dos
    // still at st 2 (the apps flip them to st 1 only when they next run), plus to-dos with no
    // start date whose deadline is today or overdue, unless that deadline was dismissed from Today.
    return this.getOpenTasks()
      .filter((t) => {
        if (t.startDate) return t.start !== 0 && t.startDate <= today;
        return Boolean(t.deadline && t.deadline <= today && !t.deadlineSuppressed);
      })
      .sort((a, b) => (a.startBucket || 0) - (b.startBucket || 0) || (a.todayIndex || 0) - (b.todayIndex || 0))
      .map((t) => this.formatTask(t));
  }

  getUpcoming(days = 14) {
    const today = this.today();
    const last = addDays(today, days);
    return this.getOpenTasks()
      .filter((t) => {
        const scheduled = t.startDate && t.startDate > today && t.startDate <= last;
        const hasDeadline = t.deadline && t.deadline > today && t.deadline <= last;
        return scheduled || hasDeadline;
      })
      .sort((a, b) => (a.startDate || a.deadline || "").localeCompare(b.startDate || b.deadline || ""))
      .map((t) => this.formatTask(t));
  }

  // Read filters take an id or a title the way writes do: case-insensitive, and an unknown or
  // ambiguous name is an error instead of an empty list.
  filterId(kind, value) {
    return value ? this.resolveRef(kind, value) : null;
  }

  matchesArea(t, area) {
    return !area || t.area === area;
  }

  matchesTag(t, tag) {
    return !tag || (t.tags || []).includes(tag);
  }

  getAnytime({ area = null, tag = null } = {}) {
    area = this.filterId("area", area);
    tag = this.filterId("tag", tag);
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

    // A bare YYYY-MM-DD bound is a calendar day in the connector's time zone, like every other date
    // the tools show; a full timestamp is compared as an instant.
    const sinceDay = isDateString(since) ? since : null;
    const untilDay = isDateString(until) ? until : null;
    const sinceTs = since && !sinceDay ? (typeof since === "number" ? since : parseIsoDate(since)) : null;
    const untilTs = until && !untilDay ? (typeof until === "number" ? until : parseIsoDate(until)) : null;

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
        const itemDay = sinceDay || untilDay ? localDate(this.timeZone, itemTs) : null;
        if (sinceDay && itemDay < sinceDay) return false;
        if (untilDay && itemDay > untilDay) return false;

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

  // The to-dos of a project, directly or under its headings. Repeating templates are left out:
  // they are hidden rule holders, and their occurrences are the to-dos.
  projectTodos(projectId) {
    return [...this.tasks.values()].filter((t) => t.type === 0 && this.isLive(t) && this.projectIdOf(t) === projectId);
  }

  getProjects({ status = "open", area = null } = {}) {
    area = this.filterId("area", area);
    return [...this.tasks.values()]
      .filter((t) => {
        if (t.type !== 1 || t.trashed) return false;
        if (status === "open" && t.status !== 0) return false;
        if (status === "completed" && t.status !== 3) return false;
        return this.matchesArea(t, area);
      })
      .map((p) => {
        const todos = this.projectTodos(p.uuid);
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
    area = this.filterId("area", area);
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
      const todos = this.projectTodos(p.uuid);
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

  // Among several items with the same title, the one a person most likely means: not trashed, not
  // a repeating template, open.
  static bestMatch(matches) {
    const rank = (t) => (t.trashed ? 4 : 0) + (t.recurrenceRule ? 2 : 0) + (t.status ? 1 : 0);
    return [...matches].sort((a, b) => rank(a) - rank(b))[0];
  }

  findProject(identifier) {
    const byId = this.tasks.get(identifier);
    if (byId?.type === 1) return byId;
    const wanted = String(identifier).toLowerCase();
    return ThingsDatabase.bestMatch([...this.tasks.values()].filter((t) => t.type === 1 && t.title && t.title.toLowerCase() === wanted));
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
        tasks: all.filter((t) => t.type === 0 && t.heading === h.uuid && this.isLive(t)).map((t) => this.formatTask(t)),
      }));

    const ungroupedTasks = all
      .filter((t) => t.type === 0 && t.project === p.uuid && !t.heading && this.isLive(t))
      .map((t) => this.formatTask(t));
    const repeatingTemplates = all
      .filter((t) => t.type === 0 && !t.trashed && t.recurrenceRule && this.projectIdOf(t) === p.uuid)
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
      // Rules that generate to-dos in this project; not to-dos themselves and not counted as open.
      repeatingTemplates: repeatingTemplates.length ? repeatingTemplates : undefined,
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
    const titled = [...this.tasks.values()].filter((task) => task.title && task.title.toLowerCase() === wanted);
    // By title: a to-do before a project or heading of the same name, then the most likely one.
    const t = this.tasks.get(taskIdentifier) || ThingsDatabase.bestMatch(titled.some((x) => x.type === 0) ? titled.filter((x) => x.type === 0) : titled);
    return t ? this.formatTask(t) : null;
  }

  search(query, { status = "open", includeNotes = true, area = null, project = null, tag = null } = {}) {
    const q = query.toLowerCase();
    area = this.filterId("area", area);
    tag = this.filterId("tag", tag);
    project = this.filterId("project", project);
    return [...this.tasks.values()]
      .filter((t) => {
        // Repeating templates are listed by getRepeatingTodos; here they would double every occurrence.
        if (!this.isLive(t) || t.type === 2) return false;
        if (status === "open" && t.status !== 0) return false;
        if (status === "completed" && t.status !== 3) return false;
        if (!this.matchesArea(t, area)) return false;
        if (project && this.projectIdOf(t) !== project) return false;
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
      if (!this.isLive(t) || this.inTrashedContainer(t) || t.status !== 0 || !t.deadline || t.type === 2) continue;
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
    const todos = [...this.tasks.values()].filter((t) => this.isLive(t) && t.type === 0 && !this.inTrashedContainer(t));

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
      openTodos: this.getOpenTasks().length,
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
