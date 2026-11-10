// The "Things list" MCP App: one interactive view shared by the to-do list tools. Hosts without
// MCP Apps support ignore the view and read each tool's text result, which is unchanged.
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { THINGS_LIST_HTML } from "./things-list-app.generated.js";

export const THINGS_LIST_URI = "ui://things3/list.html";

// Claude serves each view from a sandbox origin derived from the exact MCP URL a user adds:
// the first 32 hex characters of the URL's SHA-256, plus .claudemcpcontent.com.
export async function claudeUiDomain(serverUrl) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serverUrl));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 32)}.claudemcpcontent.com`;
}

// `_meta` for a tool whose result the view renders.
export const listToolMeta = { ui: { resourceUri: THINGS_LIST_URI } };

export async function registerThingsListApp(server, { baseUrl }) {
  const domain = await claudeUiDomain(`${baseUrl.replace(/\/+$/, "")}/mcp`);
  registerAppResource(server, "Things list", THINGS_LIST_URI, { description: "Interactive Things 3 to-do list. Tick a to-do to complete it." }, async () => ({
    contents: [
      {
        uri: THINGS_LIST_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: THINGS_LIST_HTML,
        // No external origins: the SDK client and styles are inline, icons are inline SVG, and the
        // only traffic is the host's tool-call channel.
        _meta: { ui: { prefersBorder: false, domain, csp: {} } },
      },
    ],
  }));
}

// ---- structuredContent for the view ----------------------------------------------------------

// Long lists stay well under the size where Claude stops passing results inline.
export const MAX_VIEW_ITEMS = 200;
const NOTE_CHARS = 140;

export function viewItem(t) {
  const notes = (t.notes || "").replace(/\s+/g, " ").trim();
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    when: t.when,
    scheduledDate: t.scheduledDate || null,
    deadline: t.deadline || null,
    notes: notes.length > NOTE_CHARS ? `${notes.slice(0, NOTE_CHARS - 1)}…` : notes,
    project: t.project || null,
    area: t.area || null,
    tags: t.tags || [],
    checklistCount: t.checklistCount || 0,
    checklistCompletedCount: t.checklistCompletedCount || 0,
    repeating: Boolean(t.repeatTemplateId),
  };
}

// view: today | inbox | upcoming | anytime | someday. `today` is the date the db reads as today.
export function listStructured({ view, title, todos, today }) {
  const items = todos.slice(0, MAX_VIEW_ITEMS).map(viewItem);
  return {
    view,
    title,
    today,
    items,
    totalCount: todos.length,
    truncated: todos.length > items.length,
  };
}

// A project: its headings become the view's groups; every to-do is listed so progress is exact.
export function projectStructured(project, today) {
  const groups = [
    { title: null, items: project.ungroupedTasks.map(viewItem) },
    ...project.headings.map((h) => ({ title: h.title, items: h.tasks.map(viewItem) })),
  ].filter((g) => g.items.length);
  const all = groups.flatMap((g) => g.items);
  let left = MAX_VIEW_ITEMS;
  const capped = groups.map((g) => ({ ...g, items: g.items.slice(0, Math.max(0, left)) })).map((g) => ((left -= g.items.length), g));
  const shown = capped.reduce((n, g) => n + g.items.length, 0);
  return {
    view: "project",
    title: project.title,
    notes: (project.notes || "").slice(0, 300),
    today,
    groups: capped,
    totalCount: all.length,
    completedCount: all.filter((i) => i.status === "completed").length,
    truncated: all.length > shown,
  };
}
