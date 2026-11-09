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
const CALENDAR_DATE_KEYS = ["sr", "tir", "dd"];
const LATEST_TIMESTAMP = 4102444800; // 2100-01-01; anything later is milliseconds or garbage

// Throws before anything reaches Things Cloud if a change carries an id or date that the Things
// apps cannot decode. Every write funnels through commitChanges, which calls this.
export function validateChangeMap(body) {
  const problems = [];
  for (const [id, change] of Object.entries(body)) {
    if (!isThingsId(id)) problems.push(`entity id "${id}" is not a Things id`);
    if (![0, 1, 2].includes(change?.t)) problems.push(`${id}: change type ${change?.t} is not 0, 1, or 2`);
    if (typeof change?.e !== "string" || !/^[A-Za-z]+\d+$/.test(change.e)) {
      problems.push(`${id}: entity "${change?.e}" is not a versioned entity name`);
    }
    const p = change?.p || {};
    for (const key of ID_LIST_KEYS) {
      if (!(key in p)) continue;
      if (!Array.isArray(p[key])) problems.push(`${id}: ${key} must be an array of ids`);
      else for (const ref of p[key]) if (!isThingsId(ref)) problems.push(`${id}: ${key} reference "${ref}" is not a Things id`);
    }
    for (const key of [...TIMESTAMP_KEYS, ...CALENDAR_DATE_KEYS]) {
      const v = p[key];
      if (v === null || v === undefined) continue;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > LATEST_TIMESTAMP) {
        problems.push(`${id}: ${key} must be unix seconds, got ${JSON.stringify(v)}`);
      } else if (CALENDAR_DATE_KEYS.includes(key) && v % 86400 !== 0) {
        problems.push(`${id}: ${key} must be midnight UTC, got ${v}`);
      }
    }
  }
  if (problems.length) {
    throw new Error(`Refusing to write data Things cannot decode:\n- ${problems.slice(0, 20).join("\n- ")}`);
  }
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
    return {
      historyKey: this.historyKey,
      latestServerIndex: data["latest-server-index"] || 0,
      latestSchemaVersion: data["latest-schema-version"] || SCHEMA_VERSION,
    };
  }

  async pullItems(startIndex = 0) {
    await this.ensureHistoryKey();
    const url = `${THINGS_CLOUD_BASE}/version/1/history/${this.historyKey}/items?start-index=${startIndex}`;
    const response = await this.request(url, { method: "GET" });
    if (!response.ok) throw new Error(`Failed to pull history items: ${response.status}`);
    const data = await response.json();
    return {
      schema: data.schema,
      currentItemIndex: data["current-item-index"] || 0,
      items: data.items || [],
    };
  }

  // Cached database. Within CACHE_TTL_MS it costs no requests; after that it asks for the head
  // index (one request) and pulls only items added since the last sync.
  async syncDatabase({ force = false } = {}) {
    if (!force && this._db && Date.now() - this._dbCheckedAt < CACHE_TTL_MS) return this._db;

    const meta = await this.getHistoryMetadata();
    if (this._db && meta.latestServerIndex < this._db.latestServerIndex) this._db = null; // history was reset
    if (!this._db) this._db = new ThingsDatabase(this.timeZone);
    const db = this._db;

    let start = db.latestServerIndex;
    while (start < meta.latestServerIndex) {
      const page = await this.pullItems(start);
      for (const itemMap of page.items) db.applyChangeMap(itemMap);
      // current-item-index is the server head, not the end of this page: a long history comes back
      // in capped pages, so advance by the number of items actually received.
      if (page.items.length === 0) {
        start = Math.max(start, page.currentItemIndex);
        break;
      }
      start += page.items.length;
    }

    db.latestServerIndex = Math.max(start, db.latestServerIndex);
    this._dbCheckedAt = Date.now();
    return db;
  }

  invalidateCache() {
    this._dbCheckedAt = 0;
  }

  // Things Cloud takes the changes inside the commit request itself: one POST whose body maps
  // each UUID to its change. (The separate /stage endpoint is only for oversized objects.)
  async commitChanges(changes) {
    const body = {};
    for (const change of changes) Object.assign(body, change);
    if (!Object.keys(body).length) return { serverHeadIndex: null };
    validateChangeMap(body);

    await this.ensureHistoryKey();
    // A fresh cached database already knows the head index, so a write costs one request.
    let ancestor =
      this._db && Date.now() - this._dbCheckedAt < CACHE_TTL_MS ? this._db.latestServerIndex : null;

    for (let attempt = 0; ; attempt++) {
      if (ancestor === null) ancestor = (await this.getHistoryMetadata()).latestServerIndex;
      const url = `${THINGS_CLOUD_BASE}/version/1/history/${this.historyKey}/commit?ancestor-index=${ancestor}&_cnt=1`;
      const res = await this.request(url, {
        method: "POST",
        headers: {
          Schema: String(SCHEMA_VERSION),
          "App-Id": APP_ID,
          "App-Instance-Id": APP_INSTANCE_ID,
          "Push-Priority": String(PUSH_PRIORITY),
        },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const head = data["server-head-index"] ?? null;
        if (this._db && head === ancestor + 1 && this._db.latestServerIndex === ancestor) {
          // Only our commit landed since the last sync: apply it locally instead of re-pulling.
          this._db.applyChangeMap(body);
          this._db.latestServerIndex = head;
          this._dbCheckedAt = Date.now();
        } else {
          this.invalidateCache();
        }
        return { serverHeadIndex: head };
      }
      // The index was stale (another client committed): fetch the real head and retry once.
      if ((res.status === 409 || res.status === 412) && attempt < 1) {
        ancestor = null;
        this.invalidateCache();
        continue;
      }
      throw new Error(`Commit failed: ${res.status} ${await res.text()}`);
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
    when = "inbox",
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

  // Permanently remove an item. The entity name is taken from the database.
  async deleteEntity(uuid) {
    const db = await this.syncDatabase();
    const entity = db.entityOf(uuid);
    if (!entity) throw new Error(`No item with id ${uuid}.`);
    await this.commitChanges([{ [uuid]: { t: 2, e: entity, p: {} } }]);
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

    if (deleteContents) {
      for (const t of db.tasks.values()) {
        if (t.area === uuid && !t.trashed) {
          changes.push({ [t.uuid]: { t: 1, e: ENTITY.task, p: { tr: true, md: now } } });
        }
      }
    } else {
      for (const t of db.tasks.values()) {
        if (t.area === uuid) {
          changes.push({ [t.uuid]: { t: 1, e: ENTITY.task, p: { ar: [], md: now } } });
        }
      }
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
    await this.commitChanges([{ [uuid]: { t: 2, e: ENTITY.tag, p: {} } }]);
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
    await this.commitChanges(trashed.map((t) => ({ [t.uuid]: { t: 2, e: ENTITY.task, p: {} } })));
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
    const changes = [{ [uuid]: { t: 1, e: ENTITY.task, p: { tp: 1, md: now } } }];

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
    const db = await this.syncDatabase();
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

  async batchUpdateTodos(uuids, operation, options = {}) {
    const db = await this.syncDatabase();
    const now = toUnixTimestamp();
    const changes = [];

    for (const uuid of uuids) {
      if (!db.tasks.has(uuid)) throw new Error(`Task not found: ${uuid}`);
      const patch = this.buildTaskPatch(db, {
        __uuid: uuid,
        status: operation === "complete" ? "completed" : operation === "cancel" ? "canceled" : undefined,
        trashed: operation === "trash" ? true : undefined,
        when: operation === "reschedule" ? options.when : options.when,
        deadline: options.deadline,
        completionDate: options.completionDate || options.completion_date,
        creationDate: options.creationDate || options.creation_date,
      }, now);
      changes.push({ [uuid]: { t: 1, e: ENTITY.task, p: patch } });
    }

    await this.commitChanges(changes);
    return { count: uuids.length, operation, updated: true };
  }

  async batchUpdateProjects(uuids, operation, options = {}) {
    const db = await this.syncDatabase();
    const now = toUnixTimestamp();
    const changes = [];

    for (const uuid of uuids) {
      const p = db.tasks.get(uuid);
      if (!p || p.type !== 1) throw new Error(`Project not found: ${uuid}`);
      const patch = this.buildTaskPatch(db, {
        __uuid: uuid,
        status: operation === "complete" ? "completed" : operation === "cancel" ? "canceled" : undefined,
        trashed: operation === "trash" ? true : undefined,
        when: operation === "reschedule" ? options.when : options.when,
        area: operation === "set_area" ? options.area : options.area,
        deadline: options.deadline,
        completionDate: options.completionDate || options.completion_date,
        creationDate: options.creationDate || options.creation_date,
      }, now);
      changes.push({ [uuid]: { t: 1, e: ENTITY.task, p: patch } });
    }

    await this.commitChanges(changes);
    return { count: uuids.length, operation, updated: true };
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
