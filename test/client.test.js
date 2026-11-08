import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ThingsCloudClient,
  ThingsDatabase,
  buildTaskCreate,
  crc32,
  localDate,
  schedulingFields,
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
