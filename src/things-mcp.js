import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ThingsCloudClient } from "./things-client.js";
import { remoteServerInfo } from "./brand-assets.js";
import { decryptJson } from "./oauth-storage.js";

export class ThingsMCP extends McpAgent {
  getEventStore() {
    return undefined;
  }

  async init() {
    const server = new McpServer(remoteServerInfo(this.env.CONNECTOR_BASE_URL || "https://things3mcp.org"));

    // Helper to get an authenticated client from session credentials
    const getClient = async () => {
      // The session grant id is passed as this.props.grantId or from Durable Object storage
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
      return new ThingsCloudClient(creds);
    };

    // Tool: things_get_today
    server.tool(
      "things_get_today",
      "Fetch all to-dos scheduled for Today in Things 3.",
      {},
      async () => {
        const client = await getClient();
        const db = await client.syncDatabase();
        const todayTasks = db.getToday();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                todayTasks.map((t) => ({
                  id: t.uuid,
                  title: t.title,
                  notes: t.notes || "",
                  deadline: t.deadline || null,
                  tags: t.tags || [],
                })),
                null,
                2
              ),
            },
          ],
        };
      }
    );

    // Tool: things_get_inbox
    server.tool(
      "things_get_inbox",
      "Fetch all unorganized to-dos currently in the Things 3 Inbox.",
      {},
      async () => {
        const client = await getClient();
        const db = await client.syncDatabase();
        const inboxTasks = db.getInbox();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                inboxTasks.map((t) => ({
                  id: t.uuid,
                  title: t.title,
                  notes: t.notes || "",
                })),
                null,
                2
              ),
            },
          ],
        };
      }
    );

    // Tool: things_get_projects
    server.tool(
      "things_get_projects",
      "List all active projects and areas in Things 3.",
      {},
      async () => {
        const client = await getClient();
        const db = await client.syncDatabase();
        const projects = db.getProjects();
        const areas = db.getAreas();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  projects: projects.map((p) => ({ id: p.uuid, title: p.title, area: p.area || null })),
                  areas: areas.map((a) => ({ id: a.uuid, title: a.title })),
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    // Tool: things_search
    server.tool(
      "things_search",
      "Search open to-dos in Things 3 by title or notes text.",
      {
        query: z.string().describe("Search keywords or phrase"),
      },
      async ({ query }) => {
        const client = await getClient();
        const db = await client.syncDatabase();
        const results = db.search(query);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                results.map((t) => ({
                  id: t.uuid,
                  title: t.title,
                  notes: t.notes || "",
                  status: t.status === 0 ? "open" : "completed",
                })),
                null,
                2
              ),
            },
          ],
        };
      }
    );

    // Tool: things_add_todo
    server.tool(
      "things_add_todo",
      "Create a new to-do in Things 3 (Inbox or Today), with optional notes and checklist items.",
      {
        title: z.string().describe("Title of the to-do"),
        notes: z.string().optional().describe("Detailed notes / markdown for the to-do"),
        when: z.enum(["inbox", "today", "anytime", "someday"]).default("inbox").describe("Where to place the to-do"),
        deadline: z.string().optional().describe("Optional deadline date (YYYY-MM-DD)"),
        checklist: z.array(z.string()).optional().describe("Optional list of checklist item strings"),
      },
      async ({ title, notes = "", when = "inbox", deadline = null, checklist = [] }) => {
        const client = await getClient();
        const result = await client.createTodo({ title, notes, when, deadline, checklist });
        return {
          content: [
            {
              type: "text",
              text: `Successfully created to-do: "${title}" (ID: ${result.id}) in ${when}.`,
            },
          ],
        };
      }
    );

    // Tool: things_complete_todo
    server.tool(
      "things_complete_todo",
      "Mark an existing to-do in Things 3 as completed.",
      {
        id: z.string().describe("UUID of the to-do to mark completed"),
      },
      async ({ id }) => {
        const client = await getClient();
        await client.updateTodo(id, { status: "completed" });
        return {
          content: [
            {
              type: "text",
              text: `To-do ${id} marked as completed in Things Cloud.`,
            },
          ],
        };
      }
    );

    // Tool: things_update_todo
    server.tool(
      "things_update_todo",
      "Update title, notes, or status of an existing to-do in Things 3.",
      {
        id: z.string().describe("UUID of the to-do"),
        title: z.string().optional().describe("Updated title"),
        notes: z.string().optional().describe("Updated notes"),
        status: z.enum(["open", "completed", "canceled"]).optional().describe("Updated status"),
      },
      async ({ id, title, notes, status }) => {
        const client = await getClient();
        await client.updateTodo(id, { title, notes, status });
        return {
          content: [
            {
              type: "text",
              text: `To-do ${id} updated successfully.`,
            },
          ],
        };
      }
    );

    this.server = server;
  }
}
