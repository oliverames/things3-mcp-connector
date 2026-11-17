import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ThingsCloudClient,
  ThingsDatabase,
  buildTaskCreate,
  generateUUID,
  isThingsId,
  validateChangeMap,
  parseIsoDate,
  crc32,
  localDate,
  schedulingFields,
  parseCSV,
  convertCsvToThingsJson,
  buildRepeatRule,
  buildRepeatingTaskCreate,
  firstRepeatDay,
  repeatStartDay,
} from "../src/things-client.js";

function fakeCloud({ head = 10 } = {}) {
  const calls = [];
  // A server at head N serves N history items; filler tags keep the pull consistent with the head.
  const filler = Array.from({ length: head }, () => ({ [generateUUID()]: { t: 0, e: "Tag4", p: { tt: "filler", ix: 0 } } }));
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (String(url).includes("/commit")) return json({ "server-head-index": head + 1 });
    if (String(url).endsWith("/history/KEY")) return json({ "latest-server-index": head, "latest-schema-version": 301 });
    if (String(url).includes("/items")) return json({ schema: 301, "current-item-index": head, items: filler.slice(Number(new URL(url).searchParams.get("start-index"))) });
    throw new Error(`unexpected ${url}`);
  };
  return { calls, fetchImpl };
}

test("a write is one commit POST with the change in the body and no stage call", async () => {
  const { calls, fetchImpl } = fakeCloud();
  const client = new ThingsCloudClient({ email: "a@b.c", password: "pw", historyKey: "KEY", fetchImpl });
  await client.createTodo({ title: "Claude connector test", when: "inbox" });

  assert.ok(!calls.some((c) => c.url.includes("/stage")));
  const commit = calls.find((c) => c.url.includes("/commit"));
  assert.equal(commit.method, "POST");
  assert.match(commit.url, /commit\?ancestor-index=10&_cnt=1$/);
  assert.equal(commit.headers.Schema, "301");
  const [change] = Object.values(JSON.parse(commit.body));
  assert.equal(change.e, "Task6");
  assert.equal(change.p.tt, "Claude connector test");
  assert.equal(change.p.st, 0);
});

test("repeated reads reuse the cache instead of hitting Things Cloud", async () => {
  const { calls, fetchImpl } = fakeCloud();
  const client = new ThingsCloudClient({ email: "a@b.c", password: "pw", historyKey: "KEY", fetchImpl });
  await client.syncDatabase();
  const after = calls.length;
  await client.syncDatabase();
  await client.syncDatabase();
  assert.equal(calls.length, after);
});

test("dates are midnight-UTC timestamps and Today uses the configured time zone", () => {
  // 02:30 UTC on Nov 8 is still the evening of Nov 7 in New York.
  const lateUtc = new Date("2026-11-08T02:30:00Z");
  assert.equal(localDate("America/New_York", lateUtc), "2026-11-07");
  assert.equal(localDate("UTC", lateUtc), "2026-11-08");

  const sched = schedulingFields("2030-01-02", "America/New_York");
  assert.equal(sched.sr, Date.UTC(2030, 0, 2) / 1000);
  assert.equal(sched.st, 2); // future date = Upcoming
});

test("task payloads use short keys and tag ids", () => {
  const { p } = buildTaskCreate({ title: "x", tags: ["TAGID"], area: "AREAID", timeZone: "UTC" });
  assert.deepEqual(p.tg, ["TAGID"]);
  assert.deepEqual(p.ar, ["AREAID"]);
  assert.equal(p.tr, false);
  assert.ok(!("title" in p));
});

test("the decoder reads versioned entities, short keys, and note patches", () => {
  const db = new ThingsDatabase("UTC");
  const text = "Hello world";
  db.applyChangeMap({
    T1: { t: 0, e: "Task6", p: { tt: "Task", tp: 0, ss: 0, st: 1, sr: Date.UTC(2020, 0, 1) / 1000, tg: ["G"], nt: { _t: "tx", t: 1, ch: crc32(text), v: text } } },
    G: { t: 0, e: "Tag4", p: { tt: "Tag" } },
  });
  db.applyChangeMap({ T1: { t: 1, e: "Task6", p: { nt: { _t: "tx", t: 2, ps: [{ r: "Bye", p: 0, l: 5 }] } } } });
  const task = db.getTask("T1");
  assert.equal(task.notes, "Bye world");
  assert.deepEqual(task.tags, ["Tag"]);
  assert.equal(db.getToday().length, 1);
  assert.throws(() => db.getDeepLink("missing"));
});

test("a capped history page does not skip the items after it", async () => {
  // The server reports its head (5) as current-item-index but returns only 3 items per page.
  const all = [1, 2, 3, 4, 5].map((n) => ({ [`T${n}`]: { t: 0, e: "Task6", p: { tt: `task ${n}`, tp: 0, ss: 0, st: 1, tr: false } } }));
  const fetchImpl = async (url) => {
    const json = (data) => new Response(JSON.stringify(data), { status: 200 });
    if (String(url).endsWith("/history/KEY")) return json({ "latest-server-index": 5, "latest-schema-version": 301 });
    const start = Number(new URL(url).searchParams.get("start-index"));
    return json({ schema: 301, "current-item-index": 5, items: all.slice(start, start + 3) });
  };
  const client = new ThingsCloudClient({ email: "a@b.c", password: "pw", historyKey: "KEY", fetchImpl });
  const db = await client.syncDatabase();
  assert.equal(db.tasks.size, 5);
  assert.equal(db.latestServerIndex, 5);
});

test("Upcoming lists future start dates and deadlines, not undated Today items", () => {
  const db = new ThingsDatabase("UTC");
  const day = (n) => Math.floor(Date.now() / 86400000) * 86400 + n * 86400;
  const task = (title, extra) => ({ t: 0, e: "Task6", p: { tt: title, tp: 0, ss: 0, st: 1, tr: false, ...extra } });
  db.applyChangeMap({
    TODAY: task("today only", { st: 1, sr: day(0), tir: day(0) }),
    TODAYDL: task("today with deadline", { st: 1, sr: day(0), tir: day(0), dd: day(5) }),
    LATER: task("scheduled", { st: 2, sr: day(3), tir: day(3) }),
  });
  const titles = db.getUpcoming().map((t) => t.title).sort();
  assert.deepEqual(titles, ["scheduled", "today with deadline"]);
});

// Issue #2, decided 2026-11-15: things_get_upcoming KEEPS including today's items, unlike
// Things' own Upcoming list, which excludes today. A to-do scheduled for today stays in
// Upcoming when its deadline falls in the window; a deadline of today belongs to Today.
test("Upcoming keeps today's items whose deadline is in the window (issue #2)", () => {
  const db = new ThingsDatabase("UTC");
  const day = (n) => Math.floor(Date.now() / 86400000) * 86400 + n * 86400;
  const task = (title, extra) => ({ t: 0, e: "Task6", p: { tt: title, tp: 0, ss: 0, st: 1, tr: false, ...extra } });
  db.applyChangeMap({
    TODAYDL: task("today, deadline in 5 days", { st: 1, sr: day(0), tir: day(0), dd: day(5) }),
    TODAYDLTODAY: task("today, deadline today", { st: 1, sr: day(0), tir: day(0), dd: day(0) }),
    TODAYONLY: task("today, no deadline", { st: 1, sr: day(0), tir: day(0) }),
    FUTUREDL: task("undated, deadline in 5 days", { st: 1, dd: day(5) }),
  });
  const upcoming = db.getUpcoming().map((t) => t.title).sort();
  assert.deepEqual(upcoming, ["today, deadline in 5 days", "undated, deadline in 5 days"]);
  // The today-scheduled item with a future deadline is in both lists: it is a Today item
  // whose deadline also falls in the Upcoming window.
  const today = db.getToday().map((t) => t.title).sort();
  assert.deepEqual(today, ["today, deadline in 5 days", "today, deadline today", "today, no deadline"]);
});

test("creating a to-do with completed and completion-date", async () => {
  const { calls, fetchImpl } = fakeCloud();
  const client = new ThingsCloudClient({ email: "a@b.c", password: "pw", historyKey: "KEY", fetchImpl });
  const compDate = "2026-08-31T17:00:00Z";
  const expectedTs = Date.parse(compDate) / 1000;

  const result = await client.importJson([
    {
      type: "to-do",
      attributes: {
        title: "Finished Asana task",
        completed: true,
        "completion-date": compDate,
      },
    },
  ]);

  assert.equal(result.todosCreated, 1);
  assert.equal(result.items[0].operation, "created");
  const commit = calls.find((c) => c.url.includes("/commit"));
  const [change] = Object.values(JSON.parse(commit.body));
  assert.equal(change.e, "Task6");
  assert.equal(change.p.tt, "Finished Asana task");
  assert.equal(change.p.ss, 3);
  assert.equal(change.p.sp, expectedTs);
});

test("updating the notes and both dates on an existing completed to-do", async () => {
  const existingId = generateUUID();
  const initialCreated = Date.parse("2026-08-01T10:00:00Z") / 1000;
  const initialStop = Date.parse("2026-08-10T12:00:00Z") / 1000;
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (String(url).includes("/commit")) return json({ "server-head-index": 11 });
    if (String(url).endsWith("/history/KEY")) return json({ "latest-server-index": 10, "latest-schema-version": 301 });
    if (String(url).includes("/items")) {
      return json({
        schema: 301,
        "current-item-index": 10,
        items: [
          {
            [existingId]: {
              t: 0,
              e: "Task6",
              p: {
                tt: "Original Title",
                nt: { _t: "tx", t: 1, ch: 0, v: "Old notes" },
                tp: 0,
                ss: 3,
                sp: initialStop,
                cd: initialCreated,
                tr: false,
                st: 1,
              },
            },
          },
        ],
      });
    }
    throw new Error(`unexpected ${url}`);
  };

  const client = new ThingsCloudClient({ email: "a@b.c", password: "pw", historyKey: "KEY", fetchImpl });
  const newCompDate = "2026-08-31T17:00:00Z";
  const newCreateDate = "2026-08-31T13:00:00Z";
  const expectedCompTs = Date.parse(newCompDate) / 1000;
  const expectedCreateTs = Date.parse(newCreateDate) / 1000;

  const result = await client.importJson([
    {
      type: "to-do",
      operation: "update",
      id: existingId,
      attributes: {
        notes: "Updated Asana migration notes",
        "completion-date": newCompDate,
        "creation-date": newCreateDate,
      },
    },
  ]);

  assert.equal(result.todosUpdated, 1);
  assert.equal(result.items[0].operation, "updated");
  assert.equal(result.items[0].id, existingId);

  const commit = calls.find((c) => c.url.includes("/commit"));
  const [change] = Object.values(JSON.parse(commit.body));
  assert.equal(change.p.nt.v, "Updated Asana migration notes");
  assert.equal(change.p.sp, expectedCompTs);
  assert.equal(change.p.cd, expectedCreateTs);
});

test("an update on an id that doesn't exist", async () => {
  const { calls, fetchImpl } = fakeCloud();
  const client = new ThingsCloudClient({ email: "a@b.c", password: "pw", historyKey: "KEY", fetchImpl });

  await assert.rejects(
    async () => {
      await client.importJson([
        {
          type: "to-do",
          operation: "update",
          id: "NON_EXISTENT_ID",
          attributes: {
            notes: "Should fail",
          },
        },
      ]);
    },
    {
      name: "Error",
      message: /No to-do or project with id NON_EXISTENT_ID/,
    }
  );

  // Verify no commit was made and no item was created
  assert.ok(!calls.some((c) => c.url.includes("/commit")));
});

test("a completion date on a project", async () => {
  const existingProjectId = generateUUID();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (String(url).includes("/commit")) return json({ "server-head-index": 11 });
    if (String(url).endsWith("/history/KEY")) return json({ "latest-server-index": 10, "latest-schema-version": 301 });
    if (String(url).includes("/items")) {
      return json({
        schema: 301,
        "current-item-index": 10,
        items: [
          {
            [existingProjectId]: {
              t: 0,
              e: "Task6",
              p: {
                tt: "Big Project",
                tp: 1,
                ss: 0,
                tr: false,
                st: 1,
              },
            },
          },
        ],
      });
    }
    throw new Error(`unexpected ${url}`);
  };

  const client = new ThingsCloudClient({ email: "a@b.c", password: "pw", historyKey: "KEY", fetchImpl });
  const compDate = "2026-09-01T15:00:00Z";
  const expectedCompTs = Date.parse(compDate) / 1000;

  await client.updateProject(existingProjectId, {
    status: "completed",
    completionDate: compDate,
  });

  const commit = calls.find((c) => c.url.includes("/commit"));
  const [change] = Object.values(JSON.parse(commit.body));
  assert.equal(change.e, "Task6");
  assert.equal(change.p.ss, 3);
  assert.equal(change.p.sp, expectedCompTs);
});

test("importJson creates project with completed and completion-date, and to-do with list-id does not land in Inbox", async () => {
  const areaId = generateUUID();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (String(url).includes("/commit")) return json({ "server-head-index": 11 });
    if (String(url).endsWith("/history/KEY")) return json({ "latest-server-index": 10, "latest-schema-version": 301 });
    if (String(url).includes("/items")) {
      return json({
        schema: 301,
        "current-item-index": 10,
        items: [
          {
            [areaId]: {
              t: 0,
              e: "Area3",
              p: { tt: "Work Area" },
            },
          },
        ],
      });
    }
    throw new Error(`unexpected ${url}`);
  };

  const client = new ThingsCloudClient({ email: "a@b.c", password: "pw", historyKey: "KEY", fetchImpl });
  const compDate = "2026-09-01T12:00:00Z";
  const expectedCompTs = Date.parse(compDate) / 1000;

  await client.importJson([
    {
      type: "project",
      attributes: {
        title: "Migrated Project",
        "area-id": areaId,
        completed: true,
        "completion-date": compDate,
      },
    },
    {
      type: "to-do",
      attributes: {
        title: "Area To-Do",
        "list-id": areaId,
      },
    },
  ]);

  const commit = calls.find((c) => c.url.includes("/commit"));
  const changes = Object.values(JSON.parse(commit.body));
  const projectChange = changes.find((c) => c.p.tp === 1);
  assert.equal(projectChange.p.tt, "Migrated Project");
  assert.deepEqual(projectChange.p.ar, [areaId]);
  assert.equal(projectChange.p.ss, 3);
  assert.equal(projectChange.p.sp, expectedCompTs);

  const todoChange = changes.find((c) => c.p.tp === 0);
  assert.equal(todoChange.p.tt, "Area To-Do");
  assert.deepEqual(todoChange.p.ar, [areaId]);
  assert.equal(todoChange.p.st, 1); // anytime, NOT inbox (0)
});

test("schedulingFields supports tomorrow and batchUpdateTodos can set dates", async () => {
  const sched = schedulingFields("tomorrow", "UTC");
  assert.equal(sched.st, 2);
  assert.ok(sched.sr > 0);

  const todoId = generateUUID();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (String(url).includes("/commit")) return json({ "server-head-index": 11 });
    if (String(url).endsWith("/history/KEY")) return json({ "latest-server-index": 10, "latest-schema-version": 301 });
    if (String(url).includes("/items")) {
      return json({
        schema: 301,
        "current-item-index": 10,
        items: [
          {
            [todoId]: {
              t: 0,
              e: "Task6",
              p: {
                tt: "Batch Item",
                tp: 0,
                ss: 3,
                st: 1,
                tr: false,
              },
            },
          },
        ],
      });
    }
    throw new Error(`unexpected ${url}`);
  };

  const client = new ThingsCloudClient({ email: "a@b.c", password: "pw", historyKey: "KEY", fetchImpl });
  const compDate = "2026-08-31T17:00:00Z";
  const createDate = "2026-08-31T12:00:00Z";
  const deadline = "2026-09-15";

  await client.batchUpdateTodos([todoId], "set_dates", {
    completionDate: compDate,
    creationDate: createDate,
    deadline,
  });

  const commit = calls.find((c) => c.url.includes("/commit"));
  const [change] = Object.values(JSON.parse(commit.body));
  assert.equal(change.p.sp, Date.parse(compDate) / 1000);
  assert.equal(change.p.cd, Date.parse(createDate) / 1000);
  assert.equal(change.p.dd, Date.UTC(2026, 8, 15) / 1000);
});

test("getLogbook filters by since and until dates", () => {
  const db = new ThingsDatabase();
  const t1 = Date.parse("2026-08-01T12:00:00Z") / 1000;
  const t2 = Date.parse("2026-08-15T12:00:00Z") / 1000;
  const t3 = Date.parse("2026-08-30T12:00:00Z") / 1000;

  db.applyChangeMap({ "todo-early": { t: 0, e: "Task6", p: { tt: "Early Done", tp: 0, ss: 3, sp: t1, tr: false } } });
  db.applyChangeMap({ "todo-mid": { t: 0, e: "Task6", p: { tt: "Mid Done", tp: 0, ss: 3, sp: t2, tr: false } } });
  db.applyChangeMap({ "todo-late": { t: 0, e: "Task6", p: { tt: "Late Done", tp: 0, ss: 3, sp: t3, tr: false } } });

  const all = db.getLogbook();
  assert.equal(all.length, 3);

  const filtered = db.getLogbook({ since: "2026-08-10", until: "2026-08-20" });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].title, "Mid Done");

  const sinceOnly = db.getLogbook({ since: "2026-08-20" });
  assert.equal(sinceOnly.length, 1);
  assert.equal(sinceOnly[0].title, "Late Done");
});

test("getProjectStats calculates summary metrics and progress accurately", () => {
  const db = new ThingsDatabase();
  db.applyChangeMap({ "area-1": { t: 0, e: "Area3", p: { tt: "Work" } } });
  db.applyChangeMap({ "proj-done": { t: 0, e: "Task6", p: { tt: "Finished Project", tp: 1, ss: 3, ar: ["area-1"], tr: false } } });
  db.applyChangeMap({
    "proj-active": {
      t: 0,
      e: "Task6",
      p: {
        tt: "Active Project",
        tp: 1,
        ss: 0,
        ar: ["area-1"],
        dd: Date.UTC(2020, 0, 1) / 1000, // overdue deadline in past
        tr: false,
      },
    },
  });

  db.applyChangeMap({ "t-1": { t: 0, e: "Task6", p: { tt: "Task 1", tp: 0, ss: 3, pr: ["proj-active"], tr: false } } });
  db.applyChangeMap({ "t-2": { t: 0, e: "Task6", p: { tt: "Task 2", tp: 0, ss: 0, pr: ["proj-active"], tr: false } } });

  const stats = db.getProjectStats();
  assert.equal(stats.totalProjects, 2);
  assert.equal(stats.openProjects, 1);
  assert.equal(stats.completedProjects, 1);
  assert.equal(stats.overdueProjects, 1);
  assert.equal(stats.activeProjectsTodos.total, 2);
  assert.equal(stats.activeProjectsTodos.completed, 1);
  assert.equal(stats.activeProjectsTodos.open, 1);
  assert.equal(stats.activeProjectsTodos.overallPercentComplete, 50);

  const activeProj = stats.projects.find((p) => p.id === "proj-active");
  assert.equal(activeProj.overdue, true);
  assert.equal(activeProj.percentComplete, 50);
});

test("parseCSV and convertCsvToThingsJson properly handle Asana export format", () => {
  const csv = `Task ID,Created At,Completed At,Name,Section/Column,Due Date,Notes,Projects,Tags
1001,2026-08-01,2026-08-15,Implement Auth,Backend,2026-08-20,"Auth with OAuth2, JWT",Website,security; urgent
1002,2026-08-02,,Design Landing Page,Frontend,2026-08-25,Figma designs,Website,design`;

  const parsed = convertCsvToThingsJson(csv, { defaultArea: "Engineering" });
  assert.equal(parsed.length, 2);

  const item1 = parsed[0];
  assert.equal(item1.attributes.title, "Implement Auth");
  assert.equal(item1.attributes.notes, "Auth with OAuth2, JWT");
  assert.equal(item1.attributes.completed, true);
  assert.equal(item1.attributes["completion-date"], "2026-08-15");
  assert.equal(item1.attributes.deadline, "2026-08-20");
  assert.equal(item1.attributes.heading, "Backend");
  assert.equal(item1.attributes.list, "Website");
  assert.deepEqual(item1.attributes.tags, ["security", "urgent"]);

  const item2 = parsed[1];
  assert.equal(item2.attributes.title, "Design Landing Page");
  assert.equal(item2.attributes.completed, false);
  assert.deepEqual(item2.attributes.tags, ["design"]);
});

test("batchUpdateProjects applies changes across projects", async () => {
  const proj1 = generateUUID();
  const proj2 = generateUUID();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (String(url).includes("/commit")) return json({ "server-head-index": 11 });
    if (String(url).endsWith("/history/KEY")) return json({ "latest-server-index": 10, "latest-schema-version": 301 });
    if (String(url).includes("/items")) {
      return json({
        schema: 301,
        "current-item-index": 10,
        items: [
          { [proj1]: { t: 0, e: "Task6", p: { tt: "Project 1", tp: 1, ss: 0, tr: false } } },
          { [proj2]: { t: 0, e: "Task6", p: { tt: "Project 2", tp: 1, ss: 0, tr: false } } },
        ],
      });
    }
    throw new Error(`unexpected ${url}`);
  };

  const client = new ThingsCloudClient({ email: "a@b.c", password: "pw", historyKey: "KEY", fetchImpl });
  await client.batchUpdateProjects([proj1, proj2], "complete", { completionDate: "2026-08-25T12:00:00Z" });

  const commit = calls.find((c) => c.url.includes("/commit"));
  const changes = Object.values(JSON.parse(commit.body));
  assert.equal(changes.length, 2);
  assert.equal(changes[0].p.ss, 3);
  assert.equal(changes[1].p.ss, 3);
  assert.equal(changes[0].p.sp, Date.parse("2026-08-25T12:00:00Z") / 1000);
});

test("setChecklist replaces checklist items atomically", async () => {
  const taskId = generateUUID();
  const existingChecklistId = generateUUID();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (String(url).includes("/commit")) return json({ "server-head-index": 11 });
    if (String(url).endsWith("/history/KEY")) return json({ "latest-server-index": 10, "latest-schema-version": 301 });
    if (String(url).includes("/items")) {
      return json({
        schema: 301,
        "current-item-index": 10,
        items: [
          { [taskId]: { t: 0, e: "Task6", p: { tt: "Parent Task", tp: 0, ss: 0, tr: false } } },
          { [existingChecklistId]: { t: 0, e: "ChecklistItem3", p: { tt: "Old Step", ts: [taskId], ss: 0 } } },
        ],
      });
    }
    throw new Error(`unexpected ${url}`);
  };

  const client = new ThingsCloudClient({ email: "a@b.c", password: "pw", historyKey: "KEY", fetchImpl });
  const result = await client.setChecklist(taskId, [
    "New Step 1",
    { title: "New Step 2", completed: true },
  ]);

  assert.equal(result.count, 2);
  const commit = calls.find((c) => c.url.includes("/commit"));
  const changes = JSON.parse(commit.body);
  // Contains deletion of old checklist item
  assert.ok(changes[existingChecklistId]);
  assert.equal(changes[existingChecklistId].t, 2); // type 2 = delete

  // Contains 2 newly created checklist items
  const createdKeys = Object.keys(changes).filter((id) => id !== existingChecklistId);
  assert.equal(createdKeys.length, 2);
  const item1 = changes[createdKeys[0]];
  const item2 = changes[createdKeys[1]];
  assert.equal(item1.p.tt, "New Step 1");
  assert.equal(item1.p.ss, 0);
  assert.equal(item2.p.tt, "New Step 2");
  assert.equal(item2.p.ss, 3);
});

test("updateTag, deleteTag, and deleteArea commit proper wire changes", async () => {
  const tagId = generateUUID();
  const areaId = generateUUID();
  const taskId = generateUUID();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (String(url).includes("/commit")) return json({ "server-head-index": 11 });
    if (String(url).endsWith("/history/KEY")) return json({ "latest-server-index": 10, "latest-schema-version": 301 });
    if (String(url).includes("/items")) {
      return json({
        schema: 301,
        "current-item-index": 10,
        items: [
          { [tagId]: { t: 0, e: "Tag4", p: { tt: "Old Tag", ix: 0 } } },
          { [areaId]: { t: 0, e: "Area3", p: { tt: "Old Area", ix: 0 } } },
          { [taskId]: { t: 0, e: "Task6", p: { tt: "In Area", tp: 0, ar: [areaId], ss: 0, tr: false } } },
        ],
      });
    }
    throw new Error(`unexpected ${url}`);
  };

  const client = new ThingsCloudClient({ email: "a@b.c", password: "pw", historyKey: "KEY", fetchImpl });

  // Update Tag
  await client.updateTag(tagId, { title: "New Tag Title", shortcut: "k" });
  const tagCommit = calls[calls.length - 1];
  const tagChange = Object.values(JSON.parse(tagCommit.body))[0];
  assert.equal(tagChange.p.tt, "New Tag Title");
  assert.equal(tagChange.p.sh, "k");

  // Delete Tag
  await client.deleteTag(tagId);
  const delTagCommit = calls[calls.length - 1];
  const delTagChange = Object.values(JSON.parse(delTagCommit.body))[0];
  assert.equal(delTagChange.t, 2);

  // Delete Area (unassigning contents)
  await client.deleteArea(areaId, { deleteContents: false });
  const delAreaCommit = calls[calls.length - 1];
  const delAreaChanges = JSON.parse(delAreaCommit.body);
  assert.ok(delAreaChanges[taskId]);
  assert.deepEqual(delAreaChanges[taskId].p.ar, []);
  assert.ok(delAreaChanges[areaId]);
  assert.equal(delAreaChanges[areaId].t, 2);
});

// Regression for 2026-11-09: Things 3.24 decodes every id into 16 bytes and crashes the Mac app's
// sync on anything larger. The two bad ids below are real ones the old generator wrote.
test("ids are 16-byte base58 and ids Things cannot decode are rejected", () => {
  for (let i = 0; i < 5000; i++) assert.ok(isThingsId(generateUUID()));

  assert.ok(isThingsId("StNiG2avHMHrcvDVCZHHh5")); // native, 22 characters
  assert.ok(isThingsId("FAGR63ag8YZfXwXJx6E95")); // native, 21 characters
  assert.ok(!isThingsId("fq2hP6DE61h8fAqsQsHsEB")); // 129-bit value
  assert.ok(!isThingsId("1HP7bZKWw9EJc6jZzUkCdT")); // leading "1" is a zero byte: 17 bytes
  assert.ok(!isThingsId("54ac9b6c-49ce-4f21-9079-74c1324f6a2a"));
  assert.ok(!isThingsId("0OIl0OIl0OIl0OIl0OIl0O"));
  assert.ok(!isThingsId(""));
});

test("a commit with a bad id, reference, or date is refused before it reaches Things Cloud", async () => {
  const task = (p = {}) => ({ t: 1, e: "Task6", p });
  const good = generateUUID();
  assert.doesNotThrow(() => validateChangeMap({ [good]: task({ pr: [generateUUID()], cd: 1794089397.169, dd: 1798848000 }) }));
  assert.throws(() => validateChangeMap({ fq2hP6DE61h8fAqsQsHsEB: task() }), /not a Things id/);
  assert.throws(() => validateChangeMap({ [good]: task({ pr: ["1HP7bZKWw9EJc6jZzUkCdT"] }) }), /pr reference/);
  assert.throws(() => validateChangeMap({ [good]: task({ cd: 1794089397169 }) }), /cd must be unix seconds/);
  assert.throws(() => validateChangeMap({ [good]: task({ sp: "2026-11-09T16:00:00Z" }) }), /sp must be unix seconds/);
  assert.throws(() => validateChangeMap({ [good]: task({ dd: 1798848001 }) }), /midnight UTC/);
  assert.throws(() => parseIsoDate(1794089397169), /not milliseconds/);
  assert.equal(parseIsoDate("2026-11-09T16:00:00Z"), 1794240000);

  // An id on an import_json create (a forgotten "operation": "update") is refused, not written.
  const { calls, fetchImpl } = fakeCloud();
  const client = new ThingsCloudClient({ email: "a@b.c", password: "pw", historyKey: "KEY", fetchImpl });
  for (const id of ["54ac9b6c-49ce-4f21-9079-74c1324f6a2a", generateUUID()]) {
    await assert.rejects(client.importJson([{ type: "to-do", id, attributes: { title: "x" } }]), /only accepted on updates/);
  }
  await assert.rejects(
    client.importJson([{ type: "project", attributes: { title: "p", items: [{ type: "to-do", id: generateUUID(), attributes: { title: "x" } }] } }]),
    /only accepted on updates/
  );
  assert.ok(!calls.some((c) => c.url.includes("/commit")));
});

// --- repeat rule builder ----------------------------------------------------------------------------

// Every rule sampled in things-reminders-sync docs/RECURRENCE.md, as the JSON Things 3.24.2 wrote
// for a start of Monday 2026-11-09 (1794182400). The builder must produce each one key for key.
const SAMPLED_RULES = [
  ["every day", { frequency: "daily" }, '{"fu":16,"fa":1,"of":[{"dy":0}],"tp":0,"ia":1794182400,"sr":1794182400,"rc":0,"ts":0,"rrv":4,"ed":64092211200}'],
  ["every 3 days", { frequency: "daily", interval: 3 }, '{"fu":16,"fa":3,"of":[{"dy":0}],"tp":0,"ia":1794182400,"sr":1794182400,"rc":0,"ts":0,"rrv":4,"ed":64092211200}'],
  ["weekly on Monday", { frequency: "weekly", weekdays: ["mon"] }, '{"fu":256,"fa":1,"of":[{"wd":1}],"tp":0,"ia":1794182400,"sr":1794182400,"rc":0,"ts":0,"rrv":4,"ed":64092211200}'],
  ["every 2 weeks on Monday and Thursday", { frequency: "weekly", interval: 2, weekdays: ["Thursday", "MON"] }, '{"fu":256,"fa":2,"of":[{"wd":1},{"wd":4}],"tp":0,"ia":1794182400,"sr":1794182400,"rc":0,"ts":0,"rrv":4,"ed":64092211200}'],
  ["weekdays", { frequency: "weekly", weekdays: ["mon", "tue", "wed", "thu", "fri"] }, '{"fu":256,"fa":1,"of":[{"wd":1},{"wd":2},{"wd":3},{"wd":4},{"wd":5}],"tp":0,"ia":1794182400,"sr":1794182400,"rc":0,"ts":0,"rrv":4,"ed":64092211200}'],
  ["monthly on the 15th", { frequency: "monthly", month_days: [15] }, '{"fu":8,"fa":1,"of":[{"dy":14}],"tp":0,"ia":1794182400,"sr":1794182400,"rc":0,"ts":0,"rrv":4,"ed":64092211200}'],
  ["monthly on the 1st and 15th", { frequency: "monthly", month_days: [15, 1] }, '{"fu":8,"fa":1,"of":[{"dy":0},{"dy":14}],"tp":0,"ia":1794182400,"sr":1794182400,"rc":0,"ts":0,"rrv":4,"ed":64092211200}'],
  ["monthly on the 2nd Tuesday", { frequency: "monthly", nth_weekday: { nth: 2, weekday: "tue" } }, '{"fu":8,"fa":1,"of":[{"wdo":2,"wd":2}],"tp":0,"ia":1794182400,"sr":1794182400,"rc":0,"ts":0,"rrv":4,"ed":64092211200}'],
  ["monthly on the last Friday", { frequency: "monthly", nth_weekday: { nth: "last", weekday: "fri" } }, '{"fu":8,"fa":1,"of":[{"wdo":-1,"wd":5}],"tp":0,"ia":1794182400,"sr":1794182400,"rc":0,"ts":0,"rrv":4,"ed":64092211200}'],
  ["monthly on the last day", { frequency: "monthly", month_days: ["last"] }, '{"fu":8,"fa":1,"of":[{"dy":-1}],"tp":0,"ia":1794182400,"sr":1794182400,"rc":0,"ts":0,"rrv":4,"ed":64092211200}'],
  ["yearly on November 20", { frequency: "yearly", month: 11, day: 20 }, '{"fu":4,"fa":1,"of":[{"dy":19,"mo":10}],"tp":0,"ia":1794182400,"sr":1794182400,"rc":0,"ts":0,"rrv":4,"ed":64092211200}'],
  ["yearly on the 4th Thursday of November", { frequency: "yearly", month: "November", nth_weekday: { nth: 4, weekday: "thu" } }, '{"fu":4,"fa":1,"of":[{"wdo":4,"mo":10,"wd":4}],"tp":0,"ia":1794182400,"sr":1794182400,"rc":0,"ts":0,"rrv":4,"ed":64092211200}'],
  ["after completion every 4 days", { frequency: "daily", interval: 4, after_completion: true }, '{"fu":16,"fa":4,"of":[],"tp":1,"ia":0,"sr":1794182400,"rc":0,"ts":0,"rrv":4,"ed":64092211200}'],
  ["daily, ends after 5 times", { frequency: "daily", ends: { after: 5 } }, '{"fu":16,"fa":1,"of":[{"dy":0}],"tp":0,"ia":1794182400,"sr":1794182400,"rc":5,"ts":0,"rrv":4}'],
  ["daily until 2026-12-31", { frequency: "daily", ends: { on: "2026-12-31" } }, '{"fu":16,"fa":1,"of":[{"dy":0}],"tp":0,"ia":1794182400,"sr":1794182400,"rc":0,"ts":0,"rrv":4,"ed":1798675200}'],
];

test("buildRepeatRule writes every sampled rule exactly as Things wrote it", () => {
  for (const [name, repeat, sampled] of SAMPLED_RULES) {
    assert.equal(JSON.stringify(buildRepeatRule(repeat, "2026-11-09")), sampled, name);
  }
});

test("buildRepeatRule refuses what was never sampled, naming what is supported", () => {
  const no = (repeat, pattern) => assert.throws(() => buildRepeatRule(repeat, "2026-11-09"), pattern);
  no({ frequency: "hourly" }, /Supported repeats: daily; weekly/);
  no({ frequency: "weekly", weekdays: ["mon"], after_completion: true }, /after-completion repeat every 1 week.*Supported repeats/);
  no({ frequency: "monthly", interval: 2, after_completion: true }, /Supported repeats/);
  no({ frequency: "daily", after_completion: true, ends: { after: 3 } }, /after-completion repeat with an end.*Supported repeats/);
  no({ frequency: "yearly", month: 11, nth_weekday: { nth: "last", weekday: "thu" } }, /last weekday of a month is not supported/);
  no({ frequency: "yearly", month: 2, day: "last" }, /last day of a month is not supported/);
  no({ frequency: "monthly", month_days: ["last", 15] }, /"last" together with numbered days/);
  no({ frequency: "monthly", nth_weekday: { nth: 5, weekday: "mon" } }, /nth must be 1 to 4 or "last"/);
  no({ frequency: "daily", add_deadlines: true }, /Unknown repeat option "add_deadlines"/);
  no({ frequency: "daily", reminder_time: "09:00" }, /Unknown repeat option "reminder_time"/);
  no({ frequency: "daily", weekdays: ["mon"] }, /weekdays does not apply to a daily repeat/);
  no({ frequency: "weekly" }, /needs repeat\.weekdays/);
  no({ frequency: "weekly", weekdays: ["someday"] }, /Unknown weekday/);
  no({ frequency: "monthly" }, /exactly one of repeat\.month_days/);
  no({ frequency: "monthly", month_days: [1], nth_weekday: { nth: 1, weekday: "mon" } }, /exactly one of/);
  no({ frequency: "monthly", month_days: [32] }, /days 1 to 31/);
  no({ frequency: "yearly", day: 20 }, /needs repeat\.month/);
  no({ frequency: "yearly", month: 2, day: 30 }, /day of February \(1 to 29\)/);
  no({ frequency: "daily", interval: 0 }, /interval must be a whole number from 1 to 999/);
  no({ frequency: "daily", interval: 1000 }, /interval/);
  no({ frequency: "daily", interval: 1.5 }, /interval/);
  no({ frequency: "daily", ends: { after: 0 } }, /ends\.after/);
  no({ frequency: "daily", ends: { on: "2026-12-31", after: 2 } }, /repeat\.ends must be/);
  no({ frequency: "daily", ends: { on: "2026-11-08" } }, /before the first day/);
  no({ frequency: "daily", ends: { on: "2026-02-30" } }, /does not exist/);
  no("daily", /repeat must be an object/);
});

test("first day of a repeat: next matching day by default, a given start must match", () => {
  const monday = "2026-11-09";
  assert.equal(firstRepeatDay({ frequency: "daily" }, monday), monday);
  assert.equal(firstRepeatDay({ frequency: "weekly", weekdays: ["mon"] }, monday), monday);
  assert.equal(firstRepeatDay({ frequency: "weekly", weekdays: ["thu", "sun"] }, monday), "2026-11-12");
  assert.equal(firstRepeatDay({ frequency: "monthly", month_days: [1, 15] }, monday), "2026-11-15");
  assert.equal(firstRepeatDay({ frequency: "monthly", month_days: ["last"] }, monday), "2026-11-30");
  assert.equal(firstRepeatDay({ frequency: "monthly", month_days: [31] }, monday), "2026-12-31");
  assert.equal(firstRepeatDay({ frequency: "monthly", nth_weekday: { nth: 2, weekday: "tue" } }, monday), "2026-11-10");
  assert.equal(firstRepeatDay({ frequency: "monthly", nth_weekday: { nth: "last", weekday: "fri" } }, monday), "2026-11-27");
  assert.equal(firstRepeatDay({ frequency: "yearly", month: 11, day: 20 }, monday), "2026-11-20");
  assert.equal(firstRepeatDay({ frequency: "yearly", month: 11, nth_weekday: { nth: 4, weekday: "thu" } }, monday), "2026-11-26");
  assert.equal(firstRepeatDay({ frequency: "yearly", month: 2, day: 29 }, monday), "2028-02-29");
  assert.equal(firstRepeatDay({ frequency: "daily", interval: 4, after_completion: true }, monday), monday);

  const weekly = { frequency: "weekly", weekdays: ["thu"] };
  assert.equal(repeatStartDay(weekly, undefined, monday), "2026-11-12");
  assert.equal(repeatStartDay(weekly, "2026-11-19", monday), "2026-11-19");
  assert.throws(() => repeatStartDay(weekly, "2026-11-13", monday), /not a day this repeat falls on. The next one is 2026-11-19/);
  assert.throws(() => repeatStartDay(weekly, "2026-11-05", monday), /cannot start in the past.*2026-11-12/);
});

test("buildRepeatingTaskCreate writes the template fields of the Things app", () => {
  const repeat = { frequency: "weekly", weekdays: ["mon", "thu"] };
  const plain = buildTaskCreate({ title: "Water plants", when: "someday", now: 1794200000.5 });
  const { t, e, p } = buildRepeatingTaskCreate({ title: "Water plants", repeat, start: "2026-11-09", now: 1794200000.5 });
  assert.equal(t, 0);
  assert.equal(e, "Task6");
  assert.deepEqual(Object.keys(p), Object.keys(plain.p));
  assert.deepEqual(
    { st: p.st, sb: p.sb, sr: p.sr, tir: p.tir, icsd: p.icsd, ato: p.ato, dd: p.dd, icc: p.icc, ss: p.ss, sp: p.sp, tr: p.tr, tp: p.tp, rt: p.rt, rp: p.rp, acrd: p.acrd },
    { st: 2, sb: 0, sr: null, tir: 1794182400, icsd: 1794182400, ato: null, dd: null, icc: 0, ss: 0, sp: null, tr: false, tp: 0, rt: [], rp: null, acrd: null }
  );
  assert.equal(JSON.stringify(p.rr), '{"fu":256,"fa":1,"of":[{"wd":1},{"wd":4}],"tp":0,"ia":1794182400,"sr":1794182400,"rc":0,"ts":0,"rrv":4,"ed":64092211200}');
  // Everything but the first day and the rule is what an ordinary Someday create writes.
  assert.deepEqual({ ...p, tir: null, icsd: null, rr: null, xx: null }, { ...plain.p, xx: null });
  assert.doesNotThrow(() => validateChangeMap({ [generateUUID()]: { t, e, p } }));
});
