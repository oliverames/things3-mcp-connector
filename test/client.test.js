import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ThingsCloudClient,
  ThingsDatabase,
  buildTaskCreate,
  crc32,
  localDate,
  schedulingFields,
  parseCSV,
  convertCsvToThingsJson,
} from "../src/things-client.js";

function fakeCloud({ head = 10 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (String(url).includes("/commit")) return json({ "server-head-index": head + 1 });
    if (String(url).endsWith("/history/KEY")) return json({ "latest-server-index": head, "latest-schema-version": 301 });
    if (String(url).includes("/items")) return json({ schema: 301, "current-item-index": head, items: [] });
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
  const existingId = "EXISTING_TODO_UUID";
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
  const existingProjectId = "PROJECT_UUID";
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
  const areaId = "AREA_UUID";
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

  const todoId = "BATCH_TODO_UUID";
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
  const proj1 = "PROJ_1";
  const proj2 = "PROJ_2";
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
  const taskId = "TASK_WITH_CHECKLIST";
  const existingChecklistId = "OLD_CL_1";
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
  const tagId = "TAG_1";
  const areaId = "AREA_1";
  const taskId = "TASK_IN_AREA";
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
