const THINGS_CLOUD_BASE = "https://cloud.culturedcode.com";
// Apple CoreFoundation reference date: 2001-01-01T00:00:00Z (Unix epoch - 978307200)
const CF_EPOCH_OFFSET = 978307200;

function toCFTime(date = new Date()) {
  return (date.getTime() / 1000) - CF_EPOCH_OFFSET;
}

function fromCFTime(cfTimestamp) {
  if (typeof cfTimestamp !== "number") return null;
  return new Date((cfTimestamp + CF_EPOCH_OFFSET) * 1000);
}

function generateUUID() {
  return crypto.randomUUID().toUpperCase();
}

export class ThingsCloudClient {
  constructor({ email, password, historyKey = null }) {
    this.email = email;
    this.password = password;
    this.historyKey = historyKey;
  }

  static encodePassword(pw) {
    // Things uses Cocoa stringByAddingPercentEscapesUsingEncoding: NSUTF8StringEncoding
    return encodeURIComponent(pw);
  }

  static commonHeaders(password) {
    const headers = {
      "Content-Type": "application/json; charset=UTF-8",
      "Accept": "application/json",
      "Accept-Charset": "UTF-8",
      "User-Agent": "ThingsMac/3.21.3",
      "things-client-info": JSON.stringify({
        nativeAppVersion: "3.21.3",
        preferredLanguage: "en",
        uiWritingDirection: "LTR"
      }),
    };
    if (password) {
      headers["Authorization"] = `Password ${ThingsCloudClient.encodePassword(password)}`;
    }
    return headers;
  }

  async validateAndFetchAccount() {
    const url = `${THINGS_CLOUD_BASE}/version/1/account/${encodeURIComponent(this.email)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: ThingsCloudClient.commonHeaders(this.password),
    });

    if (response.status === 401) {
      throw new Error("Invalid Things Cloud password.");
    }
    if (response.status === 404) {
      throw new Error("Things Cloud account not found for this email.");
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Things Cloud error (${response.status}): ${text}`);
    }

    const data = await response.json();
    this.historyKey = data["history-key"];
    return {
      email: data.email,
      status: data.status,
      historyKey: data["history-key"],
      mailDropEmail: data["maildrop-email"],
      slaVersionAccepted: data["SLA-version-accepted"],
      issues: data.issues || [],
    };
  }

  async getHistoryMetadata() {
    if (!this.historyKey) throw new Error("History key not configured.");
    const url = `${THINGS_CLOUD_BASE}/version/1/history/${this.historyKey}`;
    const response = await fetch(url, {
      method: "GET",
      headers: ThingsCloudClient.commonHeaders(this.password),
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch history metadata: ${response.status}`);
    }
    const data = await response.json();
    return {
      historyKey: data["history-key"],
      latestServerIndex: data["latest-server-index"] || 0,
      latestSchemaVersion: data["latest-schema-version"] || 1,
    };
  }

  async pullItems(startIndex = 0) {
    if (!this.historyKey) throw new Error("History key not configured.");
    const url = `${THINGS_CLOUD_BASE}/version/1/history/${this.historyKey}/items?start-index=${startIndex}`;
    const response = await fetch(url, {
      method: "GET",
      headers: ThingsCloudClient.commonHeaders(this.password),
    });
    if (!response.ok) {
      throw new Error(`Failed to pull history items: ${response.status}`);
    }
    const data = await response.json();
    return {
      schema: data.schema,
      currentItemIndex: data["current-item-index"] || 0,
      items: data.items || [],
    };
  }

  async syncDatabase() {
    const meta = await this.getHistoryMetadata();
    const db = new ThingsDatabase();
    let startIndex = 0;

    while (startIndex < meta.latestServerIndex) {
      const page = await this.pullItems(startIndex);
      for (const itemMap of page.items) {
        db.applyChangeMap(itemMap);
      }
      if (page.currentItemIndex <= startIndex || !page.items.length) {
        break;
      }
      startIndex = page.currentItemIndex;
    }

    db.latestServerIndex = meta.latestServerIndex;
    return db;
  }

  async stageAndCommitChanges(changes) {
    const meta = await this.getHistoryMetadata();
    const ancestorIndex = meta.latestServerIndex;
    const count = changes.length;

    // 1. Stage changes
    for (let idx = 0; idx < count; idx++) {
      const stageUrl = `${THINGS_CLOUD_BASE}/version/1/history/${this.historyKey}/stage?ancestor-index=${ancestorIndex}&_idx=${idx}&_cnt=${count}`;
      const stageRes = await fetch(stageUrl, {
        method: "POST",
        headers: ThingsCloudClient.commonHeaders(this.password),
        body: JSON.stringify(changes[idx]),
      });
      if (!stageRes.ok) {
        throw new Error(`Stage failed for item ${idx}: ${stageRes.status} ${await stageRes.text()}`);
      }
    }

    // 2. Commit changes
    const commitUrl = `${THINGS_CLOUD_BASE}/version/1/history/${this.historyKey}/commit?ancestor-index=${ancestorIndex}&_cnt=${count}`;
    const commitRes = await fetch(commitUrl, {
      method: "POST",
      headers: ThingsCloudClient.commonHeaders(this.password),
      body: JSON.stringify([]),
    });
    if (!commitRes.ok) {
      throw new Error(`Commit failed: ${commitRes.status} ${await commitRes.text()}`);
    }

    return await commitRes.json();
  }

  async createTodo({ title, notes = "", when = "inbox", deadline = null, tags = [], checklist = [] }) {
    const taskUUID = generateUUID();
    const nowCF = toCFTime();

    // Determine start mode:
    // start: 1 = Inbox, start: 2 = Anytime/Today
    let start = 1;
    let startDate = null;
    let todayIndex = null;

    if (when === "today") {
      start = 2;
      const today = new Date();
      startDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      todayIndex = 1;
    } else if (when === "anytime") {
      start = 2;
    } else if (when === "someday") {
      start = 2;
      startDate = "someday";
    }

    const taskProps = {
      title,
      notes,
      status: 0, // open
      type: 0,   // to-do
      start,
      userModificationDate: nowCF,
      creationDate: nowCF,
    };

    if (startDate && startDate !== "someday") taskProps.startDate = startDate;
    if (todayIndex !== null) taskProps.todayIndex = todayIndex;
    if (deadline) taskProps.deadline = deadline;
    if (tags.length) taskProps.tags = tags;

    const changes = [
      {
        [taskUUID]: {
          t: 0, // Insert
          e: "Task",
          p: taskProps,
        }
      }
    ];

    // Checklist items
    if (Array.isArray(checklist) && checklist.length > 0) {
      for (const item of checklist) {
        const itemUUID = generateUUID();
        changes.push({
          [itemUUID]: {
            t: 0,
            e: "ChecklistItem",
            p: {
              title: typeof item === "string" ? item : item.title,
              status: 0,
              task: taskUUID,
              userModificationDate: nowCF,
            }
          }
        });
      }
    }

    await this.stageAndCommitChanges(changes);
    return { id: taskUUID, title, when, status: "open" };
  }

  async updateTodo(uuid, updates = {}) {
    const nowCF = toCFTime();
    const taskProps = {
      userModificationDate: nowCF,
    };

    if (updates.status === "completed") {
      taskProps.status = 3;
      taskProps.stopDate = nowCF;
    } else if (updates.status === "canceled") {
      taskProps.status = 2;
      taskProps.stopDate = nowCF;
    } else if (updates.status === "open") {
      taskProps.status = 0;
      taskProps.stopDate = null;
    }

    if (updates.title !== undefined) taskProps.title = updates.title;
    if (updates.notes !== undefined) taskProps.notes = updates.notes;

    const changes = [
      {
        [uuid]: {
          t: 1, // Update
          e: "Task",
          p: taskProps,
        }
      }
    ];

    await this.stageAndCommitChanges(changes);
    return { id: uuid, updated: true };
  }
}

export class ThingsDatabase {
  constructor() {
    this.tasks = new Map();
    this.areas = new Map();
    this.tags = new Map();
    this.checklists = new Map();
    this.latestServerIndex = 0;
  }

  applyChangeMap(changeMap) {
    for (const [uuid, op] of Object.entries(changeMap)) {
      const type = op.t;
      const entity = op.e;
      const props = op.p || {};

      if (type === 2) {
        // Delete / Tombstone
        this.tasks.delete(uuid);
        this.areas.delete(uuid);
        this.tags.delete(uuid);
        this.checklists.delete(uuid);
        continue;
      }

      if (entity === "Task") {
        const existing = this.tasks.get(uuid) || { uuid };
        this.tasks.set(uuid, { ...existing, ...props, uuid });
      } else if (entity === "Area") {
        const existing = this.areas.get(uuid) || { uuid };
        this.areas.set(uuid, { ...existing, ...props, uuid });
      } else if (entity === "Tag") {
        const existing = this.tags.get(uuid) || { uuid };
        this.tags.set(uuid, { ...existing, ...props, uuid });
      } else if (entity === "ChecklistItem") {
        const existing = this.checklists.get(uuid) || { uuid };
        this.checklists.set(uuid, { ...existing, ...props, uuid });
      }
    }
  }

  getOpenTasks() {
    return Array.from(this.tasks.values()).filter(
      (t) => t.status === 0 && !t.trashed && t.type !== 1 && t.type !== 2
    );
  }

  getInbox() {
    return this.getOpenTasks().filter(
      (t) => t.start === 1 && !t.project && !t.area
    );
  }

  getToday() {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    return this.getOpenTasks().filter((t) => {
      if (t.start !== 2) return false;
      if (t.todayIndex !== undefined && t.todayIndex !== null) return true;
      if (t.startDate && t.startDate <= todayStr) return true;
      return false;
    });
  }

  getProjects() {
    return Array.from(this.tasks.values()).filter(
      (t) => t.type === 1 && t.status === 0 && !t.trashed
    );
  }

  getAreas() {
    return Array.from(this.areas.values());
  }

  search(query) {
    const q = query.toLowerCase();
    return this.getOpenTasks().filter((t) => {
      const matchTitle = t.title && t.title.toLowerCase().includes(q);
      const matchNotes = t.notes && t.notes.toLowerCase().includes(q);
      return matchTitle || matchNotes;
    });
  }
}
