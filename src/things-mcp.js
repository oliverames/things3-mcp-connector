import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ThingsCloudClient } from "./things-client.js";
import { remoteServerInfo } from "./brand-assets.js";
import { decryptJson } from "./oauth-storage.js";

const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";

function fixListToolsSchemaDialect(server) {
  const rawServer = server.server;
  const originalHandler = rawServer._requestHandlers.get("tools/list");
  if (!originalHandler) return;
  rawServer.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = await originalHandler(request, extra);
    for (const tool of result.tools ?? []) {
      if (tool.inputSchema?.$schema) tool.inputSchema.$schema = JSON_SCHEMA_2020_12;
      if (tool.outputSchema?.$schema) tool.outputSchema.$schema = JSON_SCHEMA_2020_12;
    }
    return result;
  });
}

export class ThingsMCP extends McpAgent {
  getEventStore() {
    return undefined;
  }

  async init() {
    const server = new McpServer(remoteServerInfo(this.env.CONNECTOR_BASE_URL || "https://things3mcp.org"));

    // One client per session: it holds the synced database, so repeated tool calls reuse it
    // instead of re-downloading the whole history.
    const getClient = () => {
      if (!this._clientPromise) {
        this._clientPromise = (async () => {
          let creds = null;
          if (this.props?.credentials) {
            creds = this.props.credentials;
          } else if (this.props?.encryptedCredentials && this.env.DATA_ENCRYPTION_KEY) {
            creds = await decryptJson(this.props.encryptedCredentials, this.env.DATA_ENCRYPTION_KEY);
          } else if (this.props?.grantId) {
            const credDO = this.env.OAUTH_CREDENTIALS.get(this.env.OAUTH_CREDENTIALS.idFromName(this.props.grantId));
            creds = await credDO.getCredentials();
          }

          if (!creds || !creds.email || !creds.password) {
            throw new Error("Things Cloud credentials not found for this session. Please re-authenticate.");
          }
          return new ThingsCloudClient({ ...creds, timeZone: this.env.USER_TIMEZONE });
        })();
        this._clientPromise.catch(() => {
          this._clientPromise = null;
        });
      }
      return this._clientPromise;
    };

    const textResult = (data) => ({
      content: [
        {
          type: "text",
          text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
        },
      ],
    });

    // ==========================================
    // MCP RESOURCES (Subscribed Context)
    // ==========================================

    server.resource(
      "today",
      "things://today",
      { description: "Real-time list of Today's tasks in Things 3", mimeType: "application/json" },
      async () => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return {
          contents: [
            {
              uri: "things://today",
              mimeType: "application/json",
              text: JSON.stringify(db.getToday(), null, 2),
            },
          ],
        };
      }
    );

    server.resource(
      "inbox",
      "things://inbox",
      { description: "Real-time list of Inbox tasks in Things 3", mimeType: "application/json" },
      async () => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return {
          contents: [
            {
              uri: "things://inbox",
              mimeType: "application/json",
              text: JSON.stringify(db.getInbox(), null, 2),
            },
          ],
        };
      }
    );

    server.resource(
      "upcoming",
      "things://upcoming",
      { description: "Upcoming scheduled tasks and deadlines in Things 3", mimeType: "application/json" },
      async () => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return {
          contents: [
            {
              uri: "things://upcoming",
              mimeType: "application/json",
              text: JSON.stringify(db.getUpcoming(14), null, 2),
            },
          ],
        };
      }
    );

    server.resource(
      "projects",
      "things://projects",
      { description: "List of active Projects in Things 3 with progress", mimeType: "application/json" },
      async () => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return {
          contents: [
            {
              uri: "things://projects",
              mimeType: "application/json",
              text: JSON.stringify(db.getProjects(), null, 2),
            },
          ],
        };
      }
    );

    server.resource(
      "areas",
      "things://areas",
      { description: "Areas of Responsibility in Things 3", mimeType: "application/json" },
      async () => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return {
          contents: [
            {
              uri: "things://areas",
              mimeType: "application/json",
              text: JSON.stringify(db.getAreas(), null, 2),
            },
          ],
        };
      }
    );

    server.resource(
      "stats",
      "things://stats",
      { description: "Live aggregate database statistics (counts of todos, projects, tags)", mimeType: "application/json" },
      async () => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return {
          contents: [
            {
              uri: "things://stats",
              mimeType: "application/json",
              text: JSON.stringify(db.getStats(), null, 2),
            },
          ],
        };
      }
    );

    // ==========================================
    // READ-ONLY TOOLS (readOnlyHint: true)
    // ==========================================

    // 1. things_get_today
    server.registerTool(
      "things_get_today",
      {
        title: "Get Today's To-Dos",
        description: "Fetch all to-dos scheduled for Today in Things 3, including project/area context, deadlines, checklists, and tags.",
        inputSchema: {},
        annotations: {
          title: "Get Today's To-Dos",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return textResult(db.getToday());
      }
    );

    // 2. things_get_inbox
    server.registerTool(
      "things_get_inbox",
      {
        title: "Get Inbox To-Dos",
        description: "Fetch all unorganized to-dos currently in the Things 3 Inbox.",
        inputSchema: {},
        annotations: {
          title: "Get Inbox To-Dos",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return textResult(db.getInbox());
      }
    );

    // 3. things_get_upcoming
    server.registerTool(
      "things_get_upcoming",
      {
        title: "Get Upcoming To-Dos & Deadlines",
        description: "Fetch upcoming scheduled to-dos and deadlines in Things 3 in chronological order.",
        inputSchema: {
          days: z.number().optional().default(14).describe("Number of days ahead to look (default: 14)"),
        },
        annotations: {
          title: "Get Upcoming To-Dos",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ days }) => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return textResult(db.getUpcoming(days));
      }
    );

    // 4. things_get_anytime
    server.registerTool(
      "things_get_anytime",
      {
        title: "Get Anytime To-Dos",
        description: "Fetch actionable to-dos from the Anytime list ready to be worked on.",
        inputSchema: {
          area: z.string().optional().describe("Filter by Area name or UUID"),
          tag: z.string().optional().describe("Filter by Tag name"),
        },
        annotations: {
          title: "Get Anytime To-Dos",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ area, tag }) => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return textResult(db.getAnytime({ area, tag }));
      }
    );

    // 5. things_get_someday
    server.registerTool(
      "things_get_someday",
      {
        title: "Get Someday Backlog",
        description: "Fetch all to-dos and ideas stored in the Someday backlog in Things 3.",
        inputSchema: {},
        annotations: {
          title: "Get Someday Backlog",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return textResult(db.getSomeday());
      }
    );

    // 6. things_get_logbook
    server.registerTool(
      "things_get_logbook",
      {
        title: "Get Logbook History",
        description: "Fetch completed and canceled to-dos from the Logbook history, ordered newest first.",
        inputSchema: {
          limit: z.number().optional().default(50).describe("Max items to return (default: 50)"),
          status: z.enum(["all", "completed", "canceled"]).optional().default("all").describe("Filter by status"),
        },
        annotations: {
          title: "Get Logbook History",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ limit, status }) => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return textResult(db.getLogbook(limit, status));
      }
    );

    // 7. things_get_trash
    server.registerTool(
      "things_get_trash",
      {
        title: "Get Trash Items",
        description: "Fetch all to-dos and projects currently in the Things 3 Trash.",
        inputSchema: {},
        annotations: {
          title: "Get Trash Items",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return textResult(db.getTrash());
      }
    );

    // 8. things_get_repeating_todos
    server.registerTool(
      "things_get_repeating_todos",
      {
        title: "Get Repeating To-Dos",
        description: "Fetch recurring to-do templates and repeating task definitions in Things 3.",
        inputSchema: {},
        annotations: {
          title: "Get Repeating To-Dos",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return textResult(db.getRepeatingTodos());
      }
    );

    // 9. things_get_projects
    server.registerTool(
      "things_get_projects",
      {
        title: "List Projects",
        description: "List all projects in Things 3 with completion progress, area, and deadlines.",
        inputSchema: {
          status: z.enum(["open", "completed", "all"]).optional().default("open").describe("Filter by project status"),
          area: z.string().optional().describe("Filter by Area title or UUID"),
        },
        annotations: {
          title: "List Projects",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ status, area }) => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return textResult(db.getProjects({ status, area }));
      }
    );

    // 10. things_get_project
    server.registerTool(
      "things_get_project",
      {
        title: "Get Project Details",
        description: "Get detailed structure of a specific project, including sections/headings and all nested tasks.",
        inputSchema: {
          project: z.string().describe("Project title or UUID"),
        },
        annotations: {
          title: "Get Project Details",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ project }) => {
        const client = await getClient();
        const db = await client.syncDatabase();
        const result = db.getProject(project);
        if (!result) throw new Error(`Project not found: ${project}`);
        return textResult(result);
      }
    );

    // 11. things_get_areas
    server.registerTool(
      "things_get_areas",
      {
        title: "List Areas",
        description: "List all Areas of Responsibility in Things 3 with active projects and unprojected tasks.",
        inputSchema: {},
        annotations: {
          title: "List Areas",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return textResult(db.getAreas());
      }
    );

    // 12. things_get_tags
    server.registerTool(
      "things_get_tags",
      {
        title: "List Tags",
        description: "List all tags, keyboard shortcuts, and tag hierarchies in Things 3.",
        inputSchema: {},
        annotations: {
          title: "List Tags",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return textResult(db.getTags());
      }
    );

    // 13. things_get_todo
    server.registerTool(
      "things_get_todo",
      {
        title: "Get To-Do Details",
        description: "Fetch complete details of a specific to-do by UUID or exact title.",
        inputSchema: {
          id: z.string().describe("To-do UUID or exact title"),
        },
        annotations: {
          title: "Get To-Do Details",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ id }) => {
        const client = await getClient();
        const db = await client.syncDatabase();
        const todo = db.getTask(id);
        if (!todo) throw new Error(`To-do not found: ${id}`);
        return textResult(todo);
      }
    );

    // 14. things_search
    server.registerTool(
      "things_search",
      {
        title: "Search Things",
        description: "Comprehensive search across to-dos, projects, headings, and notes with optional filtering.",
        inputSchema: {
          query: z.string().describe("Search keywords or phrase"),
          status: z.enum(["open", "completed", "all"]).optional().default("open").describe("Filter status"),
          include_notes: z.boolean().optional().default(true).describe("Include task notes in search"),
          area: z.string().optional().describe("Filter to specific Area title or UUID"),
          project: z.string().optional().describe("Filter to specific Project title or UUID"),
          tag: z.string().optional().describe("Filter to specific Tag name"),
        },
        annotations: {
          title: "Search Things",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ query, status, include_notes, area, project, tag }) => {
        const client = await getClient();
        const db = await client.syncDatabase();
        const results = db.search(query, { status, includeNotes: include_notes, area, project, tag });
        return textResult(results);
      }
    );

    // 15. things_get_account_info
    server.registerTool(
      "things_get_account_info",
      {
        title: "Get Account Info & Stats",
        description: "Fetch Things Cloud account details, Maildrop address, and database aggregate statistics.",
        inputSchema: {},
        annotations: {
          title: "Get Account Info",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        const client = await getClient();
        const account = await client.validateAndFetchAccount();
        const db = await client.syncDatabase();
        return textResult({
          email: account.email,
          status: account.status,
          mailDropEmail: account.mailDropEmail,
          historyKey: account.historyKey,
          latestServerSyncIndex: db.latestServerIndex,
          stats: db.getStats(),
        });
      }
    );

    // things_get_daily_summary
    server.registerTool(
      "things_get_daily_summary",
      {
        title: "Get Daily Summary",
        description: "Fetch a complete productivity briefing for today: tasks completed today, tasks due today, overdue tasks, and remaining Today items.",
        inputSchema: {},
        annotations: {
          title: "Get Daily Summary",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return textResult(db.getDailySummary());
      }
    );

    // things_get_deadlines
    server.registerTool(
      "things_get_deadlines",
      {
        title: "Get Deadlines Briefing",
        description: "Fetch all active tasks and projects with deadlines, categorized into Overdue, Due Today, Due This Week, and Future.",
        inputSchema: {},
        annotations: {
          title: "Get Deadlines Briefing",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return textResult(db.getDeadlines());
      }
    );

    // things_export_markdown
    server.registerTool(
      "things_export_markdown",
      {
        title: "Export List or Project as Markdown",
        description: "Export any project, or smart list ('today', 'inbox') formatted as clean GitHub-flavored Markdown with checkboxes and headings.",
        inputSchema: {
          target: z.string().describe("Target to export: 'today', 'inbox', or a Project title / UUID"),
        },
        annotations: {
          title: "Export as Markdown",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ target }) => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return textResult(db.exportMarkdown(target));
      }
    );

    // things_get_deep_link
    server.registerTool(
      "things_get_deep_link",
      {
        title: "Get Things Deep Link URL",
        description: "Generate a native macOS/iOS 'things:///show?id=...' URL scheme deep link to open and reveal any task, project, or list directly in the native Things 3 app.",
        inputSchema: {
          id: z.string().describe("UUID of the to-do, project, or area"),
        },
        annotations: {
          title: "Get Deep Link URL",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ id }) => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return textResult(db.getDeepLink(id));
      }
    );

    // ==========================================
    // MUTATING / WRITE TOOLS (readOnlyHint: false)
    // ==========================================

    // 16. things_add_todo
    server.registerTool(
      "things_add_todo",
      {
        title: "Add To-Do",
        description: "Create a new to-do in Things 3 with scheduling, reminder alert, deadline, project/heading/area, and checklist.",
        inputSchema: {
          title: z.string().describe("Title of the to-do"),
          notes: z.string().optional().describe("Notes / Markdown description"),
          when: z.enum(["inbox", "today", "evening", "anytime", "someday"]).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional().default("inbox").describe("Where or when to schedule: 'inbox', 'today', 'evening', 'anytime', 'someday', or date 'YYYY-MM-DD'"),
          reminder_time: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe("Time for reminder alert (e.g. '09:00', '14:30')"),
          deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Due date / deadline (YYYY-MM-DD)"),
          project: z.string().optional().describe("UUID of parent project"),
          heading: z.string().optional().describe("UUID of parent heading inside project"),
          area: z.string().optional().describe("UUID of parent area"),
          tags: z.array(z.string()).optional().describe("Tag names or IDs to attach (tags must already exist)"),
          checklist: z.array(z.string()).optional().describe("List of checklist item titles"),
        },
        annotations: {
          title: "Add To-Do",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (args) => {
        const client = await getClient();
        const result = await client.createTodo({
          title: args.title,
          notes: args.notes,
          when: args.when,
          reminderTime: args.reminder_time,
          deadline: args.deadline,
          project: args.project,
          heading: args.heading,
          area: args.area,
          tags: args.tags,
          checklist: args.checklist,
        });
        return textResult(`Successfully created to-do "${result.title}" (ID: ${result.id}) scheduled for ${result.when}.`);
      }
    );

    // 17. things_update_todo
    server.registerTool(
      "things_update_todo",
      {
        title: "Update To-Do",
        description: "Update any property of an existing to-do (title, notes, when, deadline, reminder, project, heading, area, status, tags).",
        inputSchema: {
          id: z.string().describe("UUID of the to-do to update"),
          title: z.string().optional().describe("Updated title"),
          notes: z.string().optional().describe("Updated notes"),
          when: z.enum(["inbox", "today", "evening", "anytime", "someday"]).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional().describe("Move or reschedule to-do"),
          reminder_time: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe("Update reminder time alert ('HH:MM')"),
          deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Update deadline ('YYYY-MM-DD')"),
          project: z.string().optional().describe("Move to project UUID"),
          heading: z.string().optional().describe("Move to heading UUID inside project"),
          area: z.string().optional().describe("Move to area UUID"),
          tags: z.array(z.string()).optional().describe("Full list of tag names or IDs (replaces existing; tags must already exist)"),
          status: z.enum(["open", "completed", "canceled"]).optional().describe("Set status"),
          trashed: z.boolean().optional().describe("Set true to trash"),
        },
        annotations: {
          title: "Update To-Do",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (args) => {
        const client = await getClient();
        await client.updateTodo(args.id, {
          title: args.title,
          notes: args.notes,
          when: args.when,
          reminderTime: args.reminder_time,
          deadline: args.deadline,
          project: args.project,
          heading: args.heading,
          area: args.area,
          tags: args.tags,
          status: args.status,
          trashed: args.trashed,
        });
        return textResult(`To-do ${args.id} updated successfully.`);
      }
    );

    // 18. things_complete_todo
    server.registerTool(
      "things_complete_todo",
      {
        title: "Complete To-Do",
        description: "Mark an existing to-do in Things 3 as completed.",
        inputSchema: {
          id: z.string().describe("UUID of the to-do to mark completed"),
        },
        annotations: {
          title: "Complete To-Do",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ id }) => {
        const client = await getClient();
        await client.updateTodo(id, { status: "completed" });
        return textResult(`To-do ${id} marked as completed in Things Cloud.`);
      }
    );

    // 19. things_cancel_todo
    server.registerTool(
      "things_cancel_todo",
      {
        title: "Cancel To-Do",
        description: "Mark an existing to-do in Things 3 as canceled.",
        inputSchema: {
          id: z.string().describe("UUID of the to-do to cancel"),
        },
        annotations: {
          title: "Cancel To-Do",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ id }) => {
        const client = await getClient();
        await client.updateTodo(id, { status: "canceled" });
        return textResult(`To-do ${id} marked as canceled in Things Cloud.`);
      }
    );

    // 20. things_duplicate_todo
    server.registerTool(
      "things_duplicate_todo",
      {
        title: "Duplicate To-Do",
        description: "Clone an existing to-do, preserving its notes, tags, project, area, and checklist items.",
        inputSchema: {
          id: z.string().describe("UUID of the to-do to duplicate"),
        },
        annotations: {
          title: "Duplicate To-Do",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ id }) => {
        const client = await getClient();
        const copy = await client.duplicateTodo(id);
        return textResult(`Duplicated to-do into new task "${copy.title}" (ID: ${copy.id}).`);
      }
    );

    // 21. things_create_project
    server.registerTool(
      "things_create_project",
      {
        title: "Create Project",
        description: "Create a new Project in Things 3 with optional area, schedule, deadline, and tags.",
        inputSchema: {
          title: z.string().describe("Project title"),
          notes: z.string().optional().describe("Project notes / markdown description"),
          area: z.string().optional().describe("UUID of parent Area"),
          when: z.enum(["today", "anytime", "someday"]).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional().default("anytime").describe("When to schedule project"),
          deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Deadline (YYYY-MM-DD)"),
          tags: z.array(z.string()).optional().describe("Tag names or IDs to attach (tags must already exist)"),
        },
        annotations: {
          title: "Create Project",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ title, notes, area, when, deadline, tags }) => {
        const client = await getClient();
        const result = await client.createProject({ title, notes, area, when, deadline, tags });
        return textResult(`Created project "${title}" (ID: ${result.id}).`);
      }
    );

    // 22. things_update_project
    server.registerTool(
      "things_update_project",
      {
        title: "Update Project",
        description: "Update a project's title, notes, area, deadline, or mark it completed/canceled.",
        inputSchema: {
          project_id: z.string().describe("Project UUID"),
          title: z.string().optional().describe("New title"),
          notes: z.string().optional().describe("New notes"),
          area: z.string().optional().describe("New Area UUID"),
          deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("New deadline (YYYY-MM-DD)"),
          status: z.enum(["open", "completed", "canceled"]).optional().describe("New status"),
          trashed: z.boolean().optional().describe("Set true to move project to Trash"),
        },
        annotations: {
          title: "Update Project",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ project_id, title, notes, area, deadline, status, trashed }) => {
        const client = await getClient();
        await client.updateProject(project_id, { title, notes, area, deadline, status, trashed });
        return textResult(`Project ${project_id} updated successfully.`);
      }
    );

    // 23. things_create_heading
    server.registerTool(
      "things_create_heading",
      {
        title: "Create Heading",
        description: "Create a section heading inside a project to organize to-dos.",
        inputSchema: {
          project_id: z.string().describe("UUID of the parent project"),
          title: z.string().describe("Heading title"),
        },
        annotations: {
          title: "Create Heading",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ project_id, title }) => {
        const client = await getClient();
        const result = await client.createHeading({ project: project_id, title });
        return textResult(`Created heading "${title}" (ID: ${result.id}) in project ${project_id}.`);
      }
    );

    // 24. things_update_heading
    server.registerTool(
      "things_update_heading",
      {
        title: "Update Heading",
        description: "Rename or delete a section heading in a project.",
        inputSchema: {
          id: z.string().describe("Heading UUID"),
          title: z.string().optional().describe("New title for heading"),
          delete: z.boolean().optional().default(false).describe("Set true to delete this heading"),
        },
        annotations: {
          title: "Update Heading",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ id, title, delete: deleted }) => {
        const client = await getClient();
        await client.updateHeading(id, { title, deleted });
        return textResult(deleted ? `Heading ${id} deleted.` : `Heading ${id} renamed to "${title}".`);
      }
    );

    // 25. things_create_area
    server.registerTool(
      "things_create_area",
      {
        title: "Create Area",
        description: "Create a new Area of Responsibility in Things 3.",
        inputSchema: {
          title: z.string().describe("Area title (e.g. 'Work', 'Personal', 'Health')"),
          tags: z.array(z.string()).optional().describe("Tag names or IDs to associate with this Area (must already exist)"),
        },
        annotations: {
          title: "Create Area",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ title, tags }) => {
        const client = await getClient();
        const result = await client.createArea({ title, tags });
        return textResult(`Created area "${title}" (ID: ${result.id}).`);
      }
    );

    // 26. things_update_area
    server.registerTool(
      "things_update_area",
      {
        title: "Update Area",
        description: "Rename an Area of Responsibility.",
        inputSchema: {
          id: z.string().describe("Area UUID"),
          title: z.string().describe("New title"),
        },
        annotations: {
          title: "Update Area",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ id, title }) => {
        const client = await getClient();
        await client.updateArea(id, { title });
        return textResult(`Area ${id} updated.`);
      }
    );

    // 27. things_create_tag
    server.registerTool(
      "things_create_tag",
      {
        title: "Create Tag",
        description: "Create a new Tag in Things 3 with optional keyboard shortcut or parent tag.",
        inputSchema: {
          title: z.string().describe("Tag name"),
          shortcut: z.string().optional().describe("Optional single character shortcut"),
          parent: z.string().optional().describe("Parent Tag UUID for hierarchical nesting"),
        },
        annotations: {
          title: "Create Tag",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ title, shortcut, parent }) => {
        const client = await getClient();
        const result = await client.createTag({ title, shortcut, parent });
        return textResult(`Created tag "${title}" (ID: ${result.id}).`);
      }
    );

    // 28. things_add_checklist_items
    server.registerTool(
      "things_add_checklist_items",
      {
        title: "Add Checklist Items",
        description: "Add one or more checklist items to an existing to-do.",
        inputSchema: {
          todo_id: z.string().describe("UUID of parent to-do"),
          items: z.array(z.string()).describe("List of checklist item strings"),
        },
        annotations: {
          title: "Add Checklist Items",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ todo_id, items }) => {
        const client = await getClient();
        const created = await client.addChecklistItems(todo_id, items);
        return textResult(`Added ${created.length} checklist items to to-do ${todo_id}.`);
      }
    );

    // 29. things_update_checklist_item
    server.registerTool(
      "things_update_checklist_item",
      {
        title: "Update Checklist Item",
        description: "Complete, cancel, uncheck, or rename an individual checklist item inside a to-do.",
        inputSchema: {
          id: z.string().describe("Checklist item UUID"),
          status: z.enum(["open", "completed", "canceled"]).optional().describe("New status"),
          title: z.string().optional().describe("New title text"),
        },
        annotations: {
          title: "Update Checklist Item",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ id, status, title }) => {
        const client = await getClient();
        await client.updateChecklistItem(id, { status, title });
        return textResult(`Checklist item ${id} updated.`);
      }
    );

    // 30. things_manage_maildrop
    server.registerTool(
      "things_manage_maildrop",
      {
        title: "Manage Maildrop Address",
        description: "Manage Things Cloud Maildrop email address (used to forward emails into your Things Inbox).",
        inputSchema: {
          action: z.enum(["get", "reset", "clear"]).describe("Action: 'get' current address, 'reset' to generate new address, or 'clear' to disable"),
        },
        annotations: {
          title: "Manage Maildrop Address",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ action }) => {
        const client = await getClient();
        if (action === "get") {
          const email = await client.getMaildropEmail();
          return textResult({ mailDropEmail: email });
        } else if (action === "reset") {
          const email = await client.resetMaildropEmail();
          return textResult(`Maildrop email reset. New address: ${email}`);
        } else if (action === "clear") {
          await client.clearMaildropEmail();
          return textResult("Maildrop email disabled.");
        }
      }
    );

    // things_move_todo
    server.registerTool(
      "things_move_todo",
      {
        title: "Move To-Do",
        description: "Move a to-do to a different list ('inbox', 'today', 'anytime', 'someday', or date), or reassign to a project, heading, or area.",
        inputSchema: {
          id: z.string().describe("To-do UUID"),
          when: z.enum(["inbox", "today", "evening", "anytime", "someday"]).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional().describe("Move to list or schedule for date"),
          project: z.string().optional().describe("Reassign to Project UUID"),
          heading: z.string().optional().describe("Reassign to Heading UUID inside project"),
          area: z.string().optional().describe("Reassign to Area UUID"),
        },
        annotations: {
          title: "Move To-Do",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ id, when, project, heading, area }) => {
        const client = await getClient();
        await client.moveTodo(id, { when, project, heading, area });
        return textResult(`To-do ${id} moved successfully.`);
      }
    );

    // things_convert_todo_to_project
    server.registerTool(
      "things_convert_todo_to_project",
      {
        title: "Convert To-Do to Project",
        description: "Promote an existing to-do into a full Project, converting its checklist items into standalone tasks.",
        inputSchema: {
          id: z.string().describe("UUID of the to-do to promote to a project"),
        },
        annotations: {
          title: "Convert To-Do to Project",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ id }) => {
        const client = await getClient();
        const result = await client.convertTodoToProject(id);
        return textResult(`Successfully converted "${result.title}" into a project with ${result.tasksCreated} tasks.`);
      }
    );

    // things_import_json
    server.registerTool(
      "things_import_json",
      {
        title: "Import Things JSON",
        description: "Batch import complex structured projects, headings, to-dos, checklists, and tags using Things 3 JSON format in a single atomic sync commit.",
        inputSchema: {
          payload: z.any().describe("Things JSON array or object containing projects or to-dos"),
        },
        annotations: {
          title: "Import Things JSON",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ payload }) => {
        const client = await getClient();
        const result = await client.importJson(payload);
        return textResult(`Imported Things JSON: created ${result.projectsCreated} projects and ${result.todosCreated} to-dos (${result.totalEntities} total entities).`);
      }
    );

    // things_add_tags
    server.registerTool(
      "things_add_tags",
      {
        title: "Add Tags to Task",
        description: "Attach one or more tags to an existing to-do or project without replacing existing tags.",
        inputSchema: {
          id: z.string().describe("UUID of the task or project"),
          tags: z.array(z.string()).describe("Array of tag names to add"),
        },
        annotations: {
          title: "Add Tags",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ id, tags }) => {
        const client = await getClient();
        await client.addTagsToTask(id, tags);
        return textResult(`Added tags [${tags.join(", ")}] to ${id}.`);
      }
    );

    // things_remove_tags
    server.registerTool(
      "things_remove_tags",
      {
        title: "Remove Tags from Task",
        description: "Remove specific tags from an existing to-do or project.",
        inputSchema: {
          id: z.string().describe("UUID of the task or project"),
          tags: z.array(z.string()).describe("Array of tag names to remove"),
        },
        annotations: {
          title: "Remove Tags",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ id, tags }) => {
        const client = await getClient();
        await client.removeTagsFromTask(id, tags);
        return textResult(`Removed tags [${tags.join(", ")}] from ${id}.`);
      }
    );

    // ==========================================
    // DESTRUCTIVE WRITE TOOLS (destructiveHint: true)
    // ==========================================

    // 31. things_delete_todo
    server.registerTool(
      "things_delete_todo",
      {
        title: "Delete To-Do",
        description: "Delete a to-do by moving it to Trash, or permanently purge it from Things Cloud.",
        inputSchema: {
          id: z.string().describe("UUID of the to-do"),
          permanent: z.boolean().optional().default(false).describe("If true, deletes permanently; if false (default), moves to Trash"),
        },
        annotations: {
          title: "Delete To-Do",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ id, permanent }) => {
        const client = await getClient();
        if (permanent) {
          await client.deleteEntity(id);
          return textResult(`To-do ${id} permanently deleted.`);
        } else {
          await client.trashTodo(id);
          return textResult(`To-do ${id} moved to Trash.`);
        }
      }
    );

    // 32. things_empty_trash
    server.registerTool(
      "things_empty_trash",
      {
        title: "Empty Trash",
        description: "Permanently delete and purge all items currently stored in the Things 3 Trash.",
        inputSchema: {},
        annotations: {
          title: "Empty Trash",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        const client = await getClient();
        const result = await client.emptyTrash();
        return textResult(`Emptied Trash: permanently purged ${result.purgedCount} items.`);
      }
    );

    // 33. things_delete_checklist_item
    server.registerTool(
      "things_delete_checklist_item",
      {
        title: "Delete Checklist Item",
        description: "Remove a checklist item from its to-do.",
        inputSchema: {
          id: z.string().describe("Checklist item UUID"),
        },
        annotations: {
          title: "Delete Checklist Item",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ id }) => {
        const client = await getClient();
        await client.deleteChecklistItem(id);
        return textResult(`Checklist item ${id} deleted.`);
      }
    );

    // 34. things_batch_update_todos
    server.registerTool(
      "things_batch_update_todos",
      {
        title: "Batch Update To-Dos",
        description: "Perform a batch update across multiple to-dos simultaneously (e.g. complete all, trash all, or reschedule all).",
        inputSchema: {
          ids: z.array(z.string()).describe("Array of to-do UUIDs"),
          operation: z.enum(["complete", "cancel", "trash", "reschedule"]).describe("Batch operation to perform"),
          when: z.enum(["today", "anytime", "someday"]).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional().describe("Required when operation is 'reschedule'"),
        },
        annotations: {
          title: "Batch Update To-Dos",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ ids, operation, when }) => {
        const client = await getClient();
        const result = await client.batchUpdateTodos(ids, operation, { when });
        return textResult(`Batch ${operation} applied to ${result.count} to-dos.`);
      }
    );

    // ==========================================
    // PROMPTS (Workflow Guides)
    // ==========================================

    server.registerPrompt(
      "daily-planning",
      {
        title: "Daily Planning",
        description: "Review today's to-dos, upcoming deadlines, and inbox items to plan and structure the day.",
      },
      () => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Help me plan my day using Things 3:
1. things_get_today to see what is already on my plate today.
2. things_get_upcoming with days: 3 to see deadlines or scheduled tasks approaching soon.
3. things_get_inbox to review any loose thoughts or captured items that need triaging.
4. Summarize and prioritize my tasks, and propose moving items or adjusting schedules where appropriate (asking for my confirmation before mutating).`,
            },
          },
        ],
      })
    );

    server.registerPrompt(
      "weekly-review",
      {
        title: "GTD Weekly Review",
        description: "Full Getting Things Done (GTD) weekly review: clear the inbox, review active projects, inspect Someday backlog, and celebrate completed wins.",
      },
      () => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Walk me through a complete GTD Weekly Review using Things 3:
1. things_get_inbox — process every inbox item (assign to project/area, set deadline, or move to Someday).
2. things_get_logbook with limit: 20 — review accomplishments from the past week.
3. things_get_projects with status: 'open' — review each active project to ensure it has at least one next action in Today or Anytime.
4. things_get_someday — skim the Someday list to see if any deferred ideas are ready to be activated.
5. things_get_trash — check if trash needs emptying.`,
            },
          },
        ],
      })
    );

    server.registerPrompt(
      "project-breakdown",
      {
        title: "Break Down Project",
        description: "Decompose a goal or milestone into a structured Things 3 project with headings, actionable to-dos, and checklists.",
      },
      () => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Help me plan and break down a new project in Things 3:
1. Ask me what outcome or milestone I want to achieve.
2. Outline the logical phases, and propose creating a project (things_create_project) with section headings (things_create_heading).
3. Populate each section with clear, bite-sized next actions (things_add_todo) with checklist items where helpful.`,
            },
          },
        ],
      })
    );

    fixListToolsSchemaDialect(server);

    this.server = server;
  }
}
