// The Things list MCP App: resource registration, the sandbox domain, the text fallback, and the
// payload the view draws. The Worker class cannot load under node, so tool wiring is checked by
// registering the same helpers on a plain McpServer and by reading the source for the tool list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { THINGS_LIST_URI, claudeUiDomain, listToolMeta, listStructured, projectStructured, viewItem, MAX_VIEW_ITEMS, registerThingsListApp } from "../src/things-app.js";
import { THINGS_LIST_HTML } from "../src/things-list-app.generated.js";
import { buildHtml } from "../scripts/build-app.mjs";

async function connected(register) {
  const server = new McpServer({ name: "t", version: "1" });
  await register(server);
  const client = new Client({ name: "c", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test("the Claude ui.domain is the first 32 hex of the SHA-256 of the MCP URL", async () => {
  // Reference value from Claude's MCP Apps docs.
  assert.equal(await claudeUiDomain("https://example.com/mcp"), "c3d80a4ed901ee05b21755a88273b4a4.claudemcpcontent.com");
  assert.match(await claudeUiDomain("https://things3mcp.org/mcp"), /^[0-9a-f]{32}\.claudemcpcontent\.com$/);
});

test("the view is served as an MCP App resource with the domain, no border, and no external origins", async () => {
  const client = await connected((s) => registerThingsListApp(s, { baseUrl: "https://things3mcp.org/" }));
  const listed = await client.listResources();
  assert.ok(listed.resources.some((r) => r.uri === THINGS_LIST_URI && r.mimeType === RESOURCE_MIME_TYPE));
  const { contents } = await client.readResource({ uri: THINGS_LIST_URI });
  assert.equal(contents[0].mimeType, "text/html;profile=mcp-app");
  assert.equal(contents[0]._meta.ui.domain, await claudeUiDomain("https://things3mcp.org/mcp"));
  assert.equal(contents[0]._meta.ui.prefersBorder, false);
  assert.deepEqual(contents[0]._meta.ui.csp, {});
  assert.equal(contents[0].text, THINGS_LIST_HTML);
});

test("a tool registered with the view's _meta advertises the ui:// resource and still returns text", async () => {
  const client = await connected((s) => {
    registerAppTool(s, "demo", { description: "d", inputSchema: { x: z.string().optional() }, _meta: listToolMeta }, async () => ({
      content: [{ type: "text", text: "[]" }],
      structuredContent: listStructured({ view: "inbox", title: "Inbox", todos: [], today: "2026-11-10" }),
    }));
  });
  const { tools } = await client.listTools();
  assert.equal(tools[0]._meta.ui.resourceUri, THINGS_LIST_URI);
  const res = await client.callTool({ name: "demo", arguments: {} });
  assert.equal(res.content[0].text, "[]");
  assert.equal(res.structuredContent.view, "inbox");
});

test("exactly the read-only list tools carry the view; no write tool does", () => {
  const src = readFileSync(new URL("../src/things-mcp.js", import.meta.url), "utf8");
  const withView = [...src.matchAll(/registerAppTool\(\s*server,\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(withView.sort(), ["things_get_anytime", "things_get_inbox", "things_get_project", "things_get_someday", "things_get_today", "things_get_upcoming"]);
  assert.equal([...src.matchAll(/_meta: listToolMeta/g)].length, withView.length);
});

test("the view payload is compact: notes are trimmed, checklists reduced to counts, lists capped", () => {
  const long = "word ".repeat(100);
  const item = viewItem({ id: "a", title: "T", status: "open", when: "today", notes: long, tags: ["x"], checklist: [{ title: "secret" }], checklistCount: 3, checklistCompletedCount: 1, deepLink: "things:///show?id=a" });
  assert.ok(item.notes.length <= 140 && item.notes.endsWith("…"));
  assert.equal(item.checklist, undefined);
  assert.equal(item.deepLink, undefined);
  assert.equal(item.checklistCompletedCount, 1);
  const many = Array.from({ length: MAX_VIEW_ITEMS + 5 }, (_, i) => ({ id: String(i), title: "t", status: "open" }));
  const s = listStructured({ view: "anytime", title: "Anytime", todos: many, today: "2026-11-10" });
  assert.equal(s.items.length, MAX_VIEW_ITEMS);
  assert.equal(s.totalCount, MAX_VIEW_ITEMS + 5);
  assert.equal(s.truncated, true);
});

test("a project payload groups by heading and counts completed to-dos from the whole project", () => {
  const t = (id, status) => ({ id, title: id, status });
  const s = projectStructured({ title: "P", notes: "n", ungroupedTasks: [t("a", "completed")], headings: [{ title: "H", tasks: [t("b", "open"), t("c", "completed")] }, { title: "Empty", tasks: [] }] }, "2026-11-10");
  assert.deepEqual(s.groups.map((g) => g.title), [null, "H"]);
  assert.equal(s.totalCount, 3);
  assert.equal(s.completedCount, 2);
});

test("the view is self-contained and only ever completes through things_complete_todo", () => {
  assert.doesNotMatch(THINGS_LIST_HTML, /\bsrc\s*=\s*["']https?:/i);
  assert.doesNotMatch(THINGS_LIST_HTML, /<link\b|@import|url\(\s*["']?https?:/i);
  const callers = [...THINGS_LIST_HTML.matchAll(/callServerTool\(\{[^}]*name:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(callers, ["things_complete_todo"]);
});

test("the generated view is current (run `npm run build:app` after editing src/app or upgrading ext-apps)", async () => {
  assert.equal(THINGS_LIST_HTML, await buildHtml());
});

test("every glyph the view references is inlined, and ids are namespaced", () => {
  const defined = new Set([...THINGS_LIST_HTML.matchAll(/<symbol id="gl-([^"]+)"/g)].map((m) => m[1]));
  const html = readFileSync(new URL("../src/app/things-list.html", import.meta.url), "utf8");
  const literal = [...html.matchAll(/(?:glyph|pair)\("([A-Za-z0-9-]+)"/g)].map((m) => m[1]);
  const wanted = new Set(["Project-Pies-400", ...literal.flatMap((n) => (/^(Source-(?!Logbook)|Checkbox-)/.test(n) ? [n, `${n}-Dark`] : [n]))]);
  for (const n of wanted) assert.ok(defined.has(n), `missing glyph ${n}`);
  const ids = [...THINGS_LIST_HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]).filter((id) => id.includes("__"));
  assert.equal(new Set(ids).size, ids.length, "glyph ids collide");
});
