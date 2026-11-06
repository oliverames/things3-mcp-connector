// Things Cloud Client & Syncrony Database Protocol Implementation
// Reverse-engineered from Cultured Code Things 3 Syncrony.framework & ThingsModel.framework

const THINGS_CLOUD_BASE = "https://cloud.culturedcode.com";

// FADay Date Format: (year << 16) | (month << 12) | (day << 7)
export function encodeFADay(dateInput) {
  if (!dateInput) return null;
  if (typeof dateInput === "number") return dateInput;
  const match = String(dateInput).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  return (year << 16) | (month << 12) | (day << 7);
}

export function decodeFADay(val) {
  if (val === null || val === undefined) return null;
  const year = val >> 16;
  const month = (val >> 12) & 0x0f;
  const day = (val >> 7) & 0x1f;
  if (year <= 0 || month <= 0 || day <= 0) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// FATime Format: (hour << 26) | (minute << 20) | (second << 14)
export function encodeFATime(timeInput) {
  if (!timeInput) return null;
  if (typeof timeInput === "number") return timeInput;
  const match = String(timeInput).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  const second = match[3] ? parseInt(match[3], 10) : 0;
  return (hour << 26) | (minute << 20) | (second << 14);
}

export function decodeFATime(val) {
  if (val === null || val === undefined) return null;
  const hour = (val >> 26) & 0x3f;
  const minute = (val >> 20) & 0x3f;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function toUnixTimestamp(date = new Date()) {
  return parseFloat((date.getTime() / 1000).toFixed(5));
}

// Things 3 standard 22-character alphanumeric UUID generator
const ALPHANUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export function generateUUID() {
  const bytes = crypto.getRandomValues(new Uint8Array(22));
  let result = "";
  for (let i = 0; i < 22; i++) {
    result += ALPHANUM[bytes[i] % ALPHANUM.length];
  }
  return result;
}

export class ThingsCloudClient {
  constructor({ email, password, historyKey = null }) {
    this.email = email.trim().toLowerCase();
    this.password = password;
    this.historyKey = historyKey;
  }

  static encodePassword(rawPassword) {
    return encodeURIComponent(rawPassword)
      .replace(/[!*'();:@&=+$,/?%#\[\]]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  }

  static commonHeaders(password) {
    return {
      "Content-Type": "application/json; charset=UTF-8",
      "Accept": "application/json",
      "User-Agent": "ThingsMac/3.21.3",
      "things-client-info": JSON.stringify({
        nativeAppVersion: "3.21.3",
        preferredLanguage: "en",
        uiWritingDirection: "LTR",
      }),
      "Authorization": `Password ${ThingsCloudClient.encodePassword(password)}`,
    };
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
      mailDropEmail: data["maildrop-email"] || null,
      slaVersionAccepted: data["SLA-version-accepted"],
      issues: data.issues || [],
    };
  }

  async getMaildropEmail() {
    const acct = await this.validateAndFetchAccount();
    return acct.mailDropEmail;
  }

  async resetMaildropEmail() {
    const url = `${THINGS_CLOUD_BASE}/version/1/account/${encodeURIComponent(this.email)}/maildrop`;
    const response = await fetch(url, {
      method: "POST",
      headers: ThingsCloudClient.commonHeaders(this.password),
    });
    if (!response.ok) {
      throw new Error(`Failed to reset maildrop: ${response.status} ${await response.text()}`);
    }
    const data = await response.json();
    return data["maildrop-email"] || null;
  }

  async clearMaildropEmail() {
    const url = `${THINGS_CLOUD_BASE}/version/1/account/${encodeURIComponent(this.email)}/maildrop`;
    const response = await fetch(url, {
      method: "DELETE",
      headers: ThingsCloudClient.commonHeaders(this.password),
    });
    if (!response.ok) {
      throw new Error(`Failed to clear maildrop: ${response.status} ${await response.text()}`);
    }
    return true;
  }

  async getHistoryMetadata() {
    if (!this.historyKey) {
      await this.validateAndFetchAccount();
    }
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
    if (!this.historyKey) {
      await this.validateAndFetchAccount();
    }
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
    if (!this.historyKey) {
      await this.validateAndFetchAccount();
    }
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

  // --- CRUD: To-Dos ---

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
    const taskUUID = generateUUID();
    const nowUnix = toUnixTimestamp();

    let start = 0;
    let startBucket = 0;
    let startDateFADay = null;
    let todayIndex = null;

    const todayDate = new Date();
    const todayStr = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, "0")}-${String(todayDate.getDate()).padStart(2, "0")}`;

    if (when === "inbox") {
      start = 0;
    } else if (when === "today" || when === "evening") {
      start = 1;
      startBucket = 1;
      startDateFADay = encodeFADay(todayStr);
      todayIndex = 1;
    } else if (when === "anytime") {
      start = 1;
      startBucket = 0;
    } else if (when === "someday") {
      start = 2;
      startBucket = 0;
    } else if (typeof when === "string" && /^\d{4}-\d{2}-\d{2}$/.test(when)) {
      start = 1;
      startDateFADay = encodeFADay(when);
      if (when <= todayStr) {
        startBucket = 1;
        todayIndex = 1;
      }
    }

    const taskProps = {
      title,
      notes,
      type: 0,
      status: 0,
      trashed: 0,
      start,
      startBucket,
      creationDate: nowUnix,
      userModificationDate: nowUnix,
    };

    if (startDateFADay !== null) taskProps.startDate = startDateFADay;
    if (todayIndex !== null) taskProps.todayIndex = todayIndex;
    if (deadline) taskProps.deadline = encodeFADay(deadline);
    if (reminderTime) taskProps.reminderTime = encodeFATime(reminderTime);
    if (project) taskProps.project = project;
    if (heading) taskProps.heading = heading;
    if (area) taskProps.area = area;
    if (Array.isArray(tags) && tags.length) taskProps.tags = tags;

    const changes = [
      {
        [taskUUID]: {
          t: 0,
          e: "Task",
          p: taskProps,
        },
      },
    ];

    if (Array.isArray(checklist) && checklist.length > 0) {
      let idx = 0;
      for (const item of checklist) {
        const itemUUID = generateUUID();
        const itemTitle = typeof item === "string" ? item : item.title;
        changes.push({
          [itemUUID]: {
            t: 0,
            e: "ChecklistItem",
            p: {
              title: itemTitle,
              status: 0,
              task: taskUUID,
              index: idx++,
              creationDate: nowUnix,
              userModificationDate: nowUnix,
            },
          },
        });
      }
      taskProps.checklistItemsCount = checklist.length;
      taskProps.openChecklistItemsCount = checklist.length;
    }

    await this.stageAndCommitChanges(changes);
    return {
      id: taskUUID,
      title,
      when,
      status: "open",
      deadline: decodeFADay(taskProps.deadline),
      reminderTime: decodeFATime(taskProps.reminderTime),
    };
  }

  async updateTodo(uuid, updates = {}) {
    const nowUnix = toUnixTimestamp();
    const taskProps = {
      userModificationDate: nowUnix,
    };

    if (updates.status === "completed") {
      taskProps.status = 3;
      taskProps.stopDate = nowUnix;
    } else if (updates.status === "canceled") {
      taskProps.status = 2;
      taskProps.stopDate = nowUnix;
    } else if (updates.status === "open") {
      taskProps.status = 0;
      taskProps.stopDate = null;
    }

    if (updates.title !== undefined) taskProps.title = updates.title;
    if (updates.notes !== undefined) taskProps.notes = updates.notes;

    if (updates.when !== undefined) {
      const todayDate = new Date();
      const todayStr = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, "0")}-${String(todayDate.getDate()).padStart(2, "0")}`;

      if (updates.when === "inbox") {
        taskProps.start = 0;
        taskProps.startBucket = 0;
        taskProps.startDate = null;
        taskProps.todayIndex = null;
      } else if (updates.when === "today" || updates.when === "evening") {
        taskProps.start = 1;
        taskProps.startBucket = 1;
        taskProps.startDate = encodeFADay(todayStr);
        taskProps.todayIndex = 1;
      } else if (updates.when === "anytime") {
        taskProps.start = 1;
        taskProps.startBucket = 0;
        taskProps.startDate = null;
        taskProps.todayIndex = null;
      } else if (updates.when === "someday") {
        taskProps.start = 2;
        taskProps.startBucket = 0;
        taskProps.startDate = null;
        taskProps.todayIndex = null;
      } else if (typeof updates.when === "string" && /^\d{4}-\d{2}-\d{2}$/.test(updates.when)) {
        taskProps.start = 1;
        taskProps.startDate = encodeFADay(updates.when);
        if (updates.when <= todayStr) {
          taskProps.startBucket = 1;
          taskProps.todayIndex = 1;
        } else {
          taskProps.startBucket = 0;
          taskProps.todayIndex = null;
        }
      }
    }

    if (updates.deadline !== undefined) {
      taskProps.deadline = updates.deadline ? encodeFADay(updates.deadline) : null;
    }
    if (updates.reminderTime !== undefined) {
      taskProps.reminderTime = updates.reminderTime ? encodeFATime(updates.reminderTime) : null;
    }
    if (updates.project !== undefined) taskProps.project = updates.project;
    if (updates.heading !== undefined) taskProps.heading = updates.heading;
    if (updates.area !== undefined) taskProps.area = updates.area;
    if (updates.tags !== undefined) taskProps.tags = updates.tags;
    if (updates.trashed !== undefined) taskProps.trashed = updates.trashed ? 1 : 0;

    const changes = [
      {
        [uuid]: {
          t: 1,
          e: "Task",
          p: taskProps,
        },
      },
    ];

    await this.stageAndCommitChanges(changes);
    return { id: uuid, updated: true };
  }

  async trashTodo(uuid) {
    return this.updateTodo(uuid, { trashed: true });
  }

  async deleteEntity(uuid) {
    const changes = [
      {
        [uuid]: {
          t: 2,
        },
      },
    ];
    await this.stageAndCommitChanges(changes);
    return { id: uuid, deleted: true };
  }

  // --- CRUD: Projects & Headings ---

  async createProject({
    title,
    notes = "",
    area = null,
    when = "anytime",
    deadline = null,
    tags = [],
  }) {
    const projectUUID = generateUUID();
    const nowUnix = toUnixTimestamp();

    let start = 1;
    let startBucket = 0;
    let startDateFADay = null;

    if (when === "today") {
      const todayDate = new Date();
      const todayStr = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, "0")}-${String(todayDate.getDate()).padStart(2, "0")}`;
      start = 1;
      startBucket = 1;
      startDateFADay = encodeFADay(todayStr);
    } else if (when === "someday") {
      start = 2;
    } else if (typeof when === "string" && /^\d{4}-\d{2}-\d{2}$/.test(when)) {
      start = 1;
      startDateFADay = encodeFADay(when);
    }

    const projectProps = {
      title,
      notes,
      type: 1,
      status: 0,
      trashed: 0,
      start,
      startBucket,
      creationDate: nowUnix,
      userModificationDate: nowUnix,
    };

    if (area) projectProps.area = area;
    if (startDateFADay !== null) projectProps.startDate = startDateFADay;
    if (deadline) projectProps.deadline = encodeFADay(deadline);
    if (Array.isArray(tags) && tags.length) projectProps.tags = tags;

    const changes = [
      {
        [projectUUID]: {
          t: 0,
          e: "Task",
          p: projectProps,
        },
      },
    ];

    await this.stageAndCommitChanges(changes);
    return { id: projectUUID, title, type: "project", status: "open" };
  }

  async updateProject(uuid, updates = {}) {
    return this.updateTodo(uuid, updates);
  }

  async createHeading({ project, title }) {
    const headingUUID = generateUUID();
    const nowUnix = toUnixTimestamp();

    const headingProps = {
      title,
      type: 2,
      project,
      status: 0,
      trashed: 0,
      creationDate: nowUnix,
      userModificationDate: nowUnix,
    };

    const changes = [
      {
        [headingUUID]: {
          t: 0,
          e: "Task",
          p: headingProps,
        },
      },
    ];

    await this.stageAndCommitChanges(changes);
    return { id: headingUUID, title, project, type: "heading" };
  }

  async updateHeading(uuid, { title, deleted = false }) {
    if (deleted) {
      return this.deleteEntity(uuid);
    }
    const changes = [
      {
        [uuid]: {
          t: 1,
          e: "Task",
          p: {
            title,
            userModificationDate: toUnixTimestamp(),
          },
        },
      },
    ];
    await this.stageAndCommitChanges(changes);
    return { id: uuid, title, updated: true };
  }

  // --- CRUD: Areas ---

  async createArea({ title, tags = [] }) {
    const areaUUID = generateUUID();
    const changes = [
      {
        [areaUUID]: {
          t: 0,
          e: "Area",
          p: {
            title,
            visible: 1,
            tags: tags,
          },
        },
      },
    ];
    await this.stageAndCommitChanges(changes);
    return { id: areaUUID, title };
  }

  async updateArea(uuid, { title, visible = 1 }) {
    const changes = [
      {
        [uuid]: {
          t: 1,
          e: "Area",
          p: {
            title,
            visible: visible ? 1 : 0,
          },
        },
      },
    ];
    await this.stageAndCommitChanges(changes);
    return { id: uuid, title, updated: true };
  }

  // --- CRUD: Tags ---

  async createTag({ title, shortcut = null, parent = null }) {
    const tagUUID = generateUUID();
    const tagProps = { title };
    if (shortcut) tagProps.shortcut = shortcut;
    if (parent) tagProps.parent = parent;

    const changes = [
      {
        [tagUUID]: {
          t: 0,
          e: "Tag",
          p: tagProps,
        },
      },
    ];
    await this.stageAndCommitChanges(changes);
    return { id: tagUUID, title, shortcut, parent };
  }

  // --- CRUD: Checklist Items ---

  async addChecklistItems(taskUUID, items) {
    const nowUnix = toUnixTimestamp();
    const changes = [];
    const created = [];

    let idx = 0;
    for (const item of items) {
      const itemUUID = generateUUID();
      const title = typeof item === "string" ? item : item.title;
      changes.push({
        [itemUUID]: {
          t: 0,
          e: "ChecklistItem",
          p: {
            title,
            status: 0,
            task: taskUUID,
            index: idx++,
            creationDate: nowUnix,
            userModificationDate: nowUnix,
          },
        },
      });
      created.push({ id: itemUUID, title, status: "open" });
    }

    await this.stageAndCommitChanges(changes);
    return created;
  }

  async updateChecklistItem(uuid, { title, status }) {
    const itemProps = {
      userModificationDate: toUnixTimestamp(),
    };
    if (title !== undefined) itemProps.title = title;
    if (status === "completed") {
      itemProps.status = 3;
      itemProps.stopDate = toUnixTimestamp();
    } else if (status === "canceled") {
      itemProps.status = 2;
      itemProps.stopDate = toUnixTimestamp();
    } else if (status === "open") {
      itemProps.status = 0;
      itemProps.stopDate = null;
    }

    const changes = [
      {
        [uuid]: {
          t: 1,
          e: "ChecklistItem",
          p: itemProps,
        },
      },
    ];
    await this.stageAndCommitChanges(changes);
    return { id: uuid, updated: true };
  }

  async deleteChecklistItem(uuid) {
    return this.deleteEntity(uuid);
  }

  // --- Batch Operations ---

  async batchUpdateTodos(uuids, operation, options = {}) {
    const nowUnix = toUnixTimestamp();
    const changes = [];

    for (const uuid of uuids) {
      const p = { userModificationDate: nowUnix };
      if (operation === "complete") {
        p.status = 3;
        p.stopDate = nowUnix;
      } else if (operation === "cancel") {
        p.status = 2;
        p.stopDate = nowUnix;
      } else if (operation === "trash") {
        p.trashed = 1;
      } else if (operation === "reschedule" && options.when) {
        if (options.when === "today") {
          const todayDate = new Date();
          const todayStr = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, "0")}-${String(todayDate.getDate()).padStart(2, "0")}`;
          p.start = 1;
          p.startBucket = 1;
          p.startDate = encodeFADay(todayStr);
          p.todayIndex = 1;
        } else if (options.when === "someday") {
          p.start = 2;
          p.startBucket = 0;
          p.startDate = null;
        } else if (options.when === "anytime") {
          p.start = 1;
          p.startBucket = 0;
          p.startDate = null;
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(options.when)) {
          p.start = 1;
          p.startDate = encodeFADay(options.when);
        }
      }

      changes.push({
        [uuid]: {
          t: 1,
          e: "Task",
          p,
        },
      });
    }

    await this.stageAndCommitChanges(changes);
    return { count: uuids.length, operation, updated: true };
  }
}

// In-Memory Database synchronized with Things Cloud
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

  resolveChecklistItems(taskUUID) {
    return Array.from(this.checklists.values())
      .filter((c) => c.task === taskUUID)
      .sort((a, b) => (a.index || 0) - (b.index || 0))
      .map((c) => ({
        id: c.uuid,
        title: c.title,
        status: c.status === 3 ? "completed" : c.status === 2 ? "canceled" : "open",
      }));
  }

  formatTask(t) {
    const projectName = t.project ? this.tasks.get(t.project)?.title || t.project : null;
    const headingName = t.heading ? this.tasks.get(t.heading)?.title || t.heading : null;
    const areaName = t.area ? this.areas.get(t.area)?.title || t.area : null;
    const checklist = this.resolveChecklistItems(t.uuid);

    let when = "anytime";
    if (t.start === 0) when = "inbox";
    else if (t.startBucket === 1) when = "today";
    else if (t.start === 2) when = "someday";
    else if (t.startDate) when = decodeFADay(t.startDate);

    return {
      id: t.uuid,
      title: t.title,
      notes: t.notes || "",
      status: t.status === 3 ? "completed" : t.status === 2 ? "canceled" : "open",
      when,
      scheduledDate: decodeFADay(t.startDate),
      deadline: decodeFADay(t.deadline),
      reminderTime: decodeFATime(t.reminderTime),
      project: projectName,
      projectId: t.project || null,
      heading: headingName,
      headingId: t.heading || null,
      area: areaName,
      areaId: t.area || null,
      tags: t.tags || [],
      checklistCount: checklist.length,
      checklistCompletedCount: checklist.filter((c) => c.status === "completed").length,
      checklist: checklist.length ? checklist : undefined,
    };
  }

  getOpenTasks() {
    return Array.from(this.tasks.values()).filter(
      (t) => t.type === 0 && t.status === 0 && !t.trashed
    );
  }

  getInbox() {
    return Array.from(this.tasks.values())
      .filter((t) => t.type === 0 && t.status === 0 && !t.trashed && t.start === 0)
      .map((t) => this.formatTask(t));
  }

  getToday() {
    const todayDate = new Date();
    const todayFADay = encodeFADay(`${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, "0")}-${String(todayDate.getDate()).padStart(2, "0")}`);

    return this.getOpenTasks()
      .filter((t) => {
        if (t.startBucket === 1) return true;
        if (t.todayIndex !== undefined && t.todayIndex !== null) return true;
        if (t.startDate && t.startDate <= todayFADay) return true;
        return false;
      })
      .map((t) => this.formatTask(t));
  }

  getUpcoming(days = 14) {
    const todayDate = new Date();
    const todayFADay = encodeFADay(`${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, "0")}-${String(todayDate.getDate()).padStart(2, "0")}`);
    const futureDate = new Date(todayDate.getTime() + days * 86400000);
    const futureFADay = encodeFADay(`${futureDate.getFullYear()}-${String(futureDate.getMonth() + 1).padStart(2, "0")}-${String(futureDate.getDate()).padStart(2, "0")}`);

    return this.getOpenTasks()
      .filter((t) => {
        const isScheduled = t.startDate && t.startDate > todayFADay && t.startDate <= futureFADay;
        const hasDeadline = t.deadline && t.deadline <= futureFADay;
        return isScheduled || hasDeadline;
      })
      .sort((a, b) => (a.startDate || a.deadline || 0) - (b.startDate || b.deadline || 0))
      .map((t) => this.formatTask(t));
  }

  getAnytime({ area = null, tag = null } = {}) {
    return this.getOpenTasks()
      .filter((t) => {
        if (t.start !== 1 || t.startBucket === 1) return false;
        if (area && t.area !== area && this.areas.get(t.area)?.title !== area) return false;
        if (tag && (!t.tags || !t.tags.includes(tag))) return false;
        return true;
      })
      .map((t) => this.formatTask(t));
  }

  getSomeday() {
    return Array.from(this.tasks.values())
      .filter((t) => t.type === 0 && t.status === 0 && !t.trashed && t.start === 2)
      .map((t) => this.formatTask(t));
  }

  getLogbook(limit = 50, statusFilter = "all") {
    return Array.from(this.tasks.values())
      .filter((t) => {
        if (t.trashed) return false;
        if (statusFilter === "completed") return t.status === 3;
        if (statusFilter === "canceled") return t.status === 2;
        return t.status === 3 || t.status === 2;
      })
      .sort((a, b) => (b.stopDate || b.userModificationDate || 0) - (a.stopDate || a.userModificationDate || 0))
      .slice(0, limit)
      .map((t) => ({
        ...this.formatTask(t),
        stopDate: t.stopDate ? new Date(t.stopDate * 1000).toISOString() : null,
      }));
  }

  getTrash() {
    return Array.from(this.tasks.values())
      .filter((t) => t.trashed === 1)
      .map((t) => this.formatTask(t));
  }

  getProjects({ status = "open", area = null } = {}) {
    return Array.from(this.tasks.values())
      .filter((t) => {
        if (t.type !== 1 || t.trashed) return false;
        if (status === "open" && t.status !== 0) return false;
        if (status === "completed" && t.status !== 3) return false;
        if (area && t.area !== area && this.areas.get(t.area)?.title !== area) return false;
        return true;
      })
      .map((p) => {
        const projectTasks = Array.from(this.tasks.values()).filter((t) => t.project === p.uuid && !t.trashed);
        const completedTasks = projectTasks.filter((t) => t.status === 3).length;
        const totalTasks = projectTasks.filter((t) => t.type === 0).length;

        return {
          id: p.uuid,
          title: p.title,
          notes: p.notes || "",
          status: p.status === 3 ? "completed" : p.status === 2 ? "canceled" : "open",
          area: p.area ? this.areas.get(p.area)?.title || p.area : null,
          areaId: p.area || null,
          deadline: decodeFADay(p.deadline),
          scheduledDate: decodeFADay(p.startDate),
          totalTasks,
          completedTasks,
          openTasks: totalTasks - completedTasks,
          tags: p.tags || [],
        };
      });
  }

  getProject(projectIdentifier) {
    const p = Array.from(this.tasks.values()).find(
      (t) => t.type === 1 && (t.uuid === projectIdentifier || (t.title && t.title.toLowerCase() === projectIdentifier.toLowerCase()))
    );
    if (!p) return null;

    const headings = Array.from(this.tasks.values())
      .filter((t) => t.type === 2 && t.project === p.uuid && !t.trashed)
      .map((h) => ({
        id: h.uuid,
        title: h.title,
        tasks: Array.from(this.tasks.values())
          .filter((t) => t.type === 0 && t.heading === h.uuid && !t.trashed)
          .map((t) => this.formatTask(t)),
      }));

    const ungroupedTasks = Array.from(this.tasks.values())
      .filter((t) => t.type === 0 && t.project === p.uuid && !t.heading && !t.trashed)
      .map((t) => this.formatTask(t));

    return {
      id: p.uuid,
      title: p.title,
      notes: p.notes || "",
      status: p.status === 3 ? "completed" : p.status === 2 ? "canceled" : "open",
      area: p.area ? this.areas.get(p.area)?.title || p.area : null,
      areaId: p.area || null,
      deadline: decodeFADay(p.deadline),
      scheduledDate: decodeFADay(p.startDate),
      tags: p.tags || [],
      headings,
      ungroupedTasks,
    };
  }

  getAreas() {
    return Array.from(this.areas.values()).map((a) => {
      const projects = Array.from(this.tasks.values())
        .filter((t) => t.type === 1 && t.area === a.uuid && t.status === 0 && !t.trashed)
        .map((p) => ({ id: p.uuid, title: p.title }));
      const openTasks = Array.from(this.tasks.values())
        .filter((t) => t.type === 0 && t.area === a.uuid && !t.project && t.status === 0 && !t.trashed)
        .map((t) => ({ id: t.uuid, title: t.title }));

      return {
        id: a.uuid,
        title: a.title,
        visible: a.visible !== 0,
        tags: a.tags || [],
        activeProjects: projects,
        unprojectedTasks: openTasks,
      };
    });
  }

  getTags() {
    return Array.from(this.tags.values()).map((t) => ({
      id: t.uuid,
      title: t.title,
      shortcut: t.shortcut || null,
      parent: t.parent ? this.tags.get(t.parent)?.title || t.parent : null,
      parentId: t.parent || null,
    }));
  }

  getTask(taskIdentifier) {
    const t = Array.from(this.tasks.values()).find(
      (task) => task.uuid === taskIdentifier || (task.title && task.title.toLowerCase() === taskIdentifier.toLowerCase())
    );
    if (!t) return null;
    return this.formatTask(t);
  }

  search(query, { status = "open", includeNotes = true, area = null, project = null, tag = null } = {}) {
    const q = query.toLowerCase();
    return Array.from(this.tasks.values())
      .filter((t) => {
        if (t.trashed) return false;
        if (status === "open" && t.status !== 0) return false;
        if (status === "completed" && t.status !== 3) return false;

        if (area && t.area !== area && this.areas.get(t.area)?.title !== area) return false;
        if (project && t.project !== project && this.tasks.get(t.project)?.title !== project) return false;
        if (tag && (!t.tags || !t.tags.includes(tag))) return false;

        const matchTitle = t.title && t.title.toLowerCase().includes(q);
        const matchNotes = includeNotes && t.notes && t.notes.toLowerCase().includes(q);
        return matchTitle || matchNotes;
      })
      .map((t) => (t.type === 1 ? { ...this.formatTask(t), isProject: true } : this.formatTask(t)));
  }

  getStats() {
    const allTasks = Array.from(this.tasks.values());
    const todos = allTasks.filter((t) => t.type === 0 && !t.trashed);
    const projects = allTasks.filter((t) => t.type === 1 && !t.trashed);

    return {
      totalTodos: todos.length,
      openTodos: todos.filter((t) => t.status === 0).length,
      completedTodos: todos.filter((t) => t.status === 3).length,
      totalProjects: projects.length,
      openProjects: projects.filter((p) => p.status === 0).length,
      totalAreas: this.areas.size,
      totalTags: this.tags.size,
      totalChecklistItems: this.checklists.size,
      trashedItems: allTasks.filter((t) => t.trashed === 1).length,
    };
  }
}
