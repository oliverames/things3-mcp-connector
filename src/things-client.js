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

// Things identifiers are 22-character base58 strings.
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function generateUUID() {
  const bytes = crypto.getRandomValues(new Uint8Array(22));
  let out = "";
  for (let i = 0; i < 22; i++) out += BASE58[bytes[i] % BASE58.length];
  return out;
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
    case "evening":
      return { st: 1, sb: 1, sr: dateToTimestamp(today), tir: dateToTimestamp(today) };
    default: {
      if (!isDateString(when)) {
        throw new Error(`Invalid "when" value "${when}". Use inbox, today, evening, anytime, someday, or YYYY-MM-DD.`);
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
  now = toUnixTimestamp(),
  timeZone,
}) {
  const sched = withReminder(schedulingFields(when, timeZone), reminderTime, timeZone);
  return {
    t: 0,
    e: ENTITY.task,
    p: {
      tt: title,
      nt: noteObject(notes),
      tp: type,
      ss: status,
      sp: status === 0 ? null : now,
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
      cd: now,
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
  }) {
    const db = await this.syncDatabase();
    const taskUUID = generateUUID();
    const now = toUnixTimestamp();

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
    const p = { md: now, ...statusFields(updates.status, now) };

    if (updates.title !== undefined) p.tt = updates.title;
    if (updates.notes !== undefined) p.nt = noteObject(updates.notes);

    if (updates.when !== undefined) Object.assign(p, withReminder(schedulingFields(updates.when, this.timeZone), null, this.timeZone), { ato: undefined });
    if (updates.when !== undefined && p.ato === undefined) delete p.ato;

    if (updates.reminderTime !== undefined) {
      const existingSr = p.sr !== undefined ? p.sr : db.tasks.get(updates.__uuid)?.startDate ? dateToTimestamp(db.tasks.get(updates.__uuid).startDate) : null;
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

    // Containers: null or "" clears; a heading implies its project.
    if (updates.project !== undefined) {
      p.pr = updates.project ? [db.resolveRef("project", updates.project)] : [];
      p.agr = [];
      if (updates.project) p.ar = [];
    }
    if (updates.heading !== undefined) {
      if (updates.heading) {
        p.agr = [db.resolveRef("heading", updates.heading)];
        p.pr = [];
        p.ar = [];
      } else {
        p.agr = [];
      }
    }
    if (updates.area !== undefined) {
      p.ar = updates.area ? [db.resolveRef("area", updates.area)] : [];
      if (updates.area) {
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

  async createProject({ title, notes = "", area = null, when = "anytime", deadline = null, tags = [] }) {
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
      timeZone: this.timeZone,
    });
    await this.commitChanges([{ [uuid]: change }]);
    return { id: uuid, title, type: "project", status: "open" };
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

    const taskFields = (attrs) => ({
      title: attrs.title || "Untitled",
      notes: attrs.notes || "",
      when: attrs.when || "anytime",
      deadline: attrs.deadline || null,
      reminderTime: attrs.reminder || attrs["reminder-time"] || null,
      tags: this.resolveTagIds(db, attrs.tags || []),
      now,
      timeZone: this.timeZone,
    });

    const addChecklist = (attrs, todoUUID) => {
      (attrs["checklist-items"] || attrs.checklist || []).forEach((cl, idx) => {
        const title = typeof cl === "string" ? cl : cl.title || cl.attributes?.title;
        changes.push({ [generateUUID()]: buildChecklistCreate({ title, task: todoUUID, index: idx, now }) });
      });
    };

    for (const item of items) {
      const type = item.type || "to-do";
      const attrs = item.attributes || {};

      if (type === "project") {
        const projectUUID = generateUUID();
        changes.push({
          [projectUUID]: buildTaskCreate({
            ...taskFields({ ...attrs, title: attrs.title || "Untitled Project" }),
            type: 1,
            area: attrs.area ? db.resolveRef("area", attrs.area) : null,
          }),
        });
        projectsCreated++;

        let headingUUID = null;
        let idx = 0;
        for (const sub of attrs.items || []) {
          const subType = sub.type || "to-do";
          const subAttrs = sub.attributes || {};
          if (subType === "heading") {
            headingUUID = generateUUID();
            changes.push({
              [headingUUID]: buildTaskCreate({
                title: subAttrs.title || "Section",
                type: 2,
                when: "anytime",
                project: projectUUID,
                now,
                timeZone: this.timeZone,
              }),
            });
          } else if (subType === "to-do") {
            const todoUUID = generateUUID();
            const change = buildTaskCreate({
              ...taskFields(subAttrs),
              project: headingUUID ? null : projectUUID,
              heading: headingUUID,
            });
            change.p.ix = idx++;
            changes.push({ [todoUUID]: change });
            todosCreated++;
            addChecklist(subAttrs, todoUUID);
          }
        }
      } else if (type === "to-do") {
        const todoUUID = generateUUID();
        changes.push({
          [todoUUID]: buildTaskCreate({
            ...taskFields({ ...attrs, when: attrs.when || "inbox" }),
            project: attrs["list-id"] ? db.resolveRef("project", attrs["list-id"]) : attrs.list ? db.resolveRef("project", attrs.list) : null,
          }),
        });
        todosCreated++;
        addChecklist(attrs, todoUUID);
      }
    }

    await this.commitChanges(changes);
    return { projectsCreated, todosCreated, totalEntities: changes.length };
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
      const p = { md: now };
      if (operation === "complete") Object.assign(p, statusFields("completed", now));
      else if (operation === "cancel") Object.assign(p, statusFields("canceled", now));
      else if (operation === "trash") p.tr = true;
      else if (operation === "reschedule" && options.when) {
        Object.assign(p, schedulingFields(options.when, this.timeZone));
      }
      changes.push({ [uuid]: { t: 1, e: ENTITY.task, p } });
    }

    await this.commitChanges(changes);
    return { count: uuids.length, operation, updated: true };
  }
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

  getLogbook(limit = 50, statusFilter = "all") {
    return [...this.tasks.values()]
      .filter((t) => {
        if (t.trashed || t.type === 2) return false;
        if (statusFilter === "completed") return t.status === 3;
        if (statusFilter === "canceled") return t.status === 2;
        return t.status === 3 || t.status === 2;
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
          totalTasks: todos.length,
          completedTasks: completed,
          openTasks: todos.length - completed,
          tags: this.tagTitles(p.tags),
        };
      });
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
