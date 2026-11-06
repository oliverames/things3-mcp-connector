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

    const getClient = async () => {
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

    const textResult = (data) => ({
      content: [
        {
          type: "text",
          text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
        },
      ],
    });

    // 1. things_get_today
    server.tool(
      "things_get_today",
      "Fetch all to-dos scheduled for Today in Things 3, including project/area context, deadlines, checklists, and tags.",
      {},
      async () => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return textResult(db.getToday());
      }
    );

    // 2. things_get_inbox
    server.tool(
      "things_get_inbox",
      "Fetch all unorganized to-dos currently in the Things 3 Inbox.",
      {},
      async () => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return textResult(db.getInbox());
      }
    );

    // 3. things_get_upcoming
    server.tool(
      "things_get_upcoming",
      "Fetch upcoming scheduled to-dos and deadlines in Things 3 in chronological order.",
      {
        days: z.number().optional().default(14).describe("Number of days ahead to look (default: 14)"),
      },
      async ({ days }) => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return textResult(db.getUpcoming(days));
      }
    );

    // 4. things_get_anytime
    server.tool(
      "things_get_anytime",
      "Fetch actionable to-dos from the Anytime list ready to be worked on.",
      {
        area: z.string().optional().describe("Filter by Area name or UUID"),
        tag: z.string().optional().describe("Filter by Tag name"),
      },
      async ({ area, tag }) => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return textResult(db.getAnytime({ area, tag }));
      }
    );

    // 5. things_get_someday
    server.tool(
      "things_get_someday",
      "Fetch all to-dos and ideas stored in the Someday backlog in Things 3.",
      {},
      async () => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return textResult(db.getSomeday());
      }
    );

    // 6. things_get_logbook
    server.tool(
      "things_get_logbook",
      "Fetch completed and canceled to-dos from the Logbook history, ordered newest first.",
      {
        limit: z.number().optional().default(50).describe("Max items to return (default: 50)"),
        status: z.enum(["all", "completed", "canceled"]).optional().default("all").describe("Filter by status"),
      },
      async ({ limit, status }) => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return textResult(db.getLogbook(limit, status));
      }
    );

    // 7. things_get_trash
    server.tool(
      "things_get_trash",
      "Fetch all to-dos and projects currently in the Things 3 Trash.",
      {},
      async () => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return textResult(db.getTrash());
      }
    );

    // 8. things_get_projects
    server.tool(
      "things_get_projects",
      "List all active projects in Things 3 with completion progress, area, and deadlines.",
      {
        status: z.enum(["open", "completed", "all"]).optional().default("open").describe("Filter by project status"),
        area: z.string().optional().describe("Filter by Area title or UUID"),
      },
      async ({ status, area }) => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return textResult(db.getProjects({ status, area }));
      }
    );

    // 9. things_get_project
    server.tool(
      "things_get_project",
      "Get detailed structure of a specific project, including sections/headings and all nested tasks.",
      {
        project: z.string().describe("Project title or UUID"),
      },
      async ({ project }) => {
        const client = await getClient();
        const db = await client.syncDatabase();
        const result = db.getProject(project);
        if (!result) throw new Error(`Project not found: ${project}`);
        return textResult(result);
      }
    );

    // 10. things_create_project
    server.tool(
      "things_create_project",
      "Create a new Project in Things 3 with optional area, schedule, deadline, and tags.",
      {
        title: z.string().describe("Project title"),
        notes: z.string().optional().describe("Project notes / markdown description"),
        area: z.string().optional().describe("UUID of the parent Area"),
        when: z.enum(["today", "anytime", "someday"]).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional().default("anytime").describe("When to schedule project"),
        deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Deadline (YYYY-MM-DD)"),
        tags: z.array(z.string()).optional().describe("Tags to attach"),
      },
      async ({ title, notes, area, when, deadline, tags }) => {
        const client = await getClient();
        const result = await client.createProject({ title, notes, area, when, deadline, tags });
        return textResult(`Created project "${title}" (ID: ${result.id}).`);
      }
    );

    // 11. things_update_project
    server.tool(
      "things_update_project",
      "Update a project's title, notes, area, deadline, or mark it completed/canceled.",
      {
        project_id: z.string().describe("Project UUID"),
        title: z.string().optional().describe("New title"),
        notes: z.string().optional().describe("New notes"),
        area: z.string().optional().describe("New Area UUID"),
        deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("New deadline (YYYY-MM-DD)"),
        status: z.enum(["open", "completed", "canceled"]).optional().describe("New status"),
        trashed: z.boolean().optional().describe("Set true to move project to Trash"),
      },
      async ({ project_id, title, notes, area, deadline, status, trashed }) => {
        const client = await getClient();
        await client.updateProject(project_id, { title, notes, area, deadline, status, trashed });
        return textResult(`Project ${project_id} updated successfully.`);
      }
    );

    // 12. things_create_heading
    server.tool(
      "things_create_heading",
      "Create a section heading inside a project to organize to-dos.",
      {
        project_id: z.string().describe("UUID of the parent project"),
        title: z.string().describe("Heading title"),
      },
      async ({ project_id, title }) => {
        const client = await getClient();
        const result = await client.createHeading({ project: project_id, title });
        return textResult(`Created heading "${title}" (ID: ${result.id}) in project ${project_id}.`);
      }
    );

    // 13. things_update_heading
    server.tool(
      "things_update_heading",
      "Rename or delete a section heading in a project.",
      {
        id: z.string().describe("Heading UUID"),
        title: z.string().optional().describe("New title for heading"),
        delete: z.boolean().optional().default(false).describe("Set true to delete this heading"),
      },
      async ({ id, title, delete: deleted }) => {
        const client = await getClient();
        await client.updateHeading(id, { title, deleted });
        return textResult(deleted ? `Heading ${id} deleted.` : `Heading ${id} renamed to "${title}".`);
      }
    );

    // 14. things_get_areas
    server.tool(
      "things_get_areas",
      "List all Areas of Responsibility in Things 3 with their active projects and unprojected tasks.",
      {},
      async () => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return textResult(db.getAreas());
      }
    );

    // 15. things_create_area
    server.tool(
      "things_create_area",
      "Create a new Area of Responsibility in Things 3.",
      {
        title: z.string().describe("Area title (e.g. 'Work', 'Personal', 'Health')"),
        tags: z.array(z.string()).optional().describe("Tags to associate with this Area"),
      },
      async ({ title, tags }) => {
        const client = await getClient();
        const result = await client.createArea({ title, tags });
        return textResult(`Created area "${title}" (ID: ${result.id}).`);
      }
    );

    // 16. things_update_area
    server.tool(
      "things_update_area",
      "Rename or update visibility of an Area of Responsibility.",
      {
        id: z.string().describe("Area UUID"),
        title: z.string().optional().describe("New title"),
        visible: z.boolean().optional().describe("Area visibility in sidebar"),
      },
      async ({ id, title, visible }) => {
        const client = await getClient();
        await client.updateArea(id, { title, visible });
        return textResult(`Area ${id} updated.`);
      }
    );

    // 17. things_get_tags
    server.tool(
      "things_get_tags",
      "List all tags and tag hierarchies in Things 3.",
      {},
      async () => {
        const client = await getClient();
        const db = await client.syncDatabase();
        return textResult(db.getTags());
      }
    );

    // 18. things_create_tag
    server.tool(
      "things_create_tag",
      "Create a new Tag in Things 3 with optional keyboard shortcut or parent tag.",
      {
        title: z.string().describe("Tag name"),
        shortcut: z.string().optional().describe("Optional single character shortcut"),
        parent: z.string().optional().describe("Parent Tag UUID for hierarchical nesting"),
      },
      async ({ title, shortcut, parent }) => {
        const client = await getClient();
        const result = await client.createTag({ title, shortcut, parent });
        return textResult(`Created tag "${title}" (ID: ${result.id}).`);
      }
    );

    // 19. things_get_todo
    server.tool(
      "things_get_todo",
      "Fetch complete details of a specific to-do by UUID or exact title.",
      {
        id: z.string().describe("To-do UUID or exact title"),
      },
      async ({ id }) => {
        const client = await getClient();
        const db = await client.syncDatabase();
        const todo = db.getTask(id);
        if (!todo) throw new Error(`To-do not found: ${id}`);
        return textResult(todo);
      }
    );

    // 20. things_add_todo
    server.tool(
      "things_add_todo",
      "Create a new to-do in Things 3 with full control over scheduling, reminders, deadline, project/heading/area, and checklist.",
      {
        title: z.string().describe("Title of the to-do"),
        notes: z.string().optional().describe("Notes / Markdown description"),
        when: z.enum(["inbox", "today", "evening", "anytime", "someday"]).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional().default("inbox").describe("Where or when to schedule: 'inbox', 'today', 'evening', 'anytime', 'someday', or specific date 'YYYY-MM-DD'"),
        reminder_time: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe("Time for reminder alert (e.g. '09:00', '14:30')"),
        deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Due date / deadline (YYYY-MM-DD)"),
        project: z.string().optional().describe("UUID of parent project"),
        heading: z.string().optional().describe("UUID of parent heading inside project"),
        area: z.string().optional().describe("UUID of parent area"),
        tags: z.array(z.string()).optional().describe("Tags to attach"),
        checklist: z.array(z.string()).optional().describe("List of checklist item titles"),
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

    // 21. things_update_todo
    server.tool(
      "things_update_todo",
      "Update any property of an existing to-do (title, notes, when, deadline, reminder, project, heading, area, status, tags).",
      {
        id: z.string().describe("UUID of the to-do to update"),
        title: z.string().optional().describe("Updated title"),
        notes: z.string().optional().describe("Updated notes"),
        when: z.enum(["inbox", "today", "evening", "anytime", "someday"]).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional().describe("Move or reschedule to-do"),
        reminder_time: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe("Update reminder time alert ('HH:MM')"),
        deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Update deadline ('YYYY-MM-DD')"),
        project: z.string().optional().describe("Move to project UUID"),
        heading: z.string().optional().describe("Move to heading UUID inside project"),
        area: z.string().optional().describe("Move to area UUID"),
        tags: z.array(z.string()).optional().describe("Updated list of tags"),
        status: z.enum(["open", "completed", "canceled"]).optional().describe("Set status"),
        trashed: z.boolean().optional().describe("Set true to trash"),
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

    // 22. things_complete_todo
    server.tool(
      "things_complete_todo",
      "Mark an existing to-do in Things 3 as completed.",
      {
        id: z.string().describe("UUID of the to-do to mark completed"),
      },
      async ({ id }) => {
        const client = await getClient();
        await client.updateTodo(id, { status: "completed" });
        return textResult(`To-do ${id} marked as completed in Things Cloud.`);
      }
    );

    // 23. things_cancel_todo
    server.tool(
      "things_cancel_todo",
      "Mark an existing to-do in Things 3 as canceled.",
      {
        id: z.string().describe("UUID of the to-do to cancel"),
      },
      async ({ id }) => {
        const client = await getClient();
        await client.updateTodo(id, { status: "canceled" });
        return textResult(`To-do ${id} marked as canceled in Things Cloud.`);
      }
    );

    // 24. things_delete_todo
    server.tool(
      "things_delete_todo",
      "Delete a to-do by moving it to Trash, or permanently purge it from Things Cloud.",
      {
        id: z.string().describe("UUID of the to-do"),
        permanent: z.boolean().optional().default(false).describe("If true, deletes permanently; if false (default), moves to Trash"),
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

    // 25. things_add_checklist_items
    server.tool(
      "things_add_checklist_items",
      "Add one or more checklist items to an existing to-do.",
      {
        todo_id: z.string().describe("UUID of the parent to-do"),
        items: z.array(z.string()).describe("List of checklist item strings"),
      },
      async ({ todo_id, items }) => {
        const client = await getClient();
        const created = await client.addChecklistItems(todo_id, items);
        return textResult(`Added ${created.length} checklist items to to-do ${todo_id}.`);
      }
    );

    // 26. things_update_checklist_item
    server.tool(
      "things_update_checklist_item",
      "Complete, cancel, uncheck, or rename an individual checklist item inside a to-do.",
      {
        id: z.string().describe("Checklist item UUID"),
        status: z.enum(["open", "completed", "canceled"]).optional().describe("New status"),
        title: z.string().optional().describe("New title text"),
      },
      async ({ id, status, title }) => {
        const client = await getClient();
        await client.updateChecklistItem(id, { status, title });
        return textResult(`Checklist item ${id} updated.`);
      }
    );

    // 27. things_delete_checklist_item
    server.tool(
      "things_delete_checklist_item",
      "Remove a checklist item from its to-do.",
      {
        id: z.string().describe("Checklist item UUID"),
      },
      async ({ id }) => {
        const client = await getClient();
        await client.deleteChecklistItem(id);
        return textResult(`Checklist item ${id} deleted.`);
      }
    );

    // 28. things_batch_update_todos
    server.tool(
      "things_batch_update_todos",
      "Perform a batch update across multiple to-dos simultaneously (e.g. complete all, trash all, or reschedule all).",
      {
        ids: z.array(z.string()).describe("Array of to-do UUIDs"),
        operation: z.enum(["complete", "cancel", "trash", "reschedule"]).describe("Batch operation to perform"),
        when: z.enum(["today", "anytime", "someday"]).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional().describe("Required when operation is 'reschedule'"),
      },
      async ({ ids, operation, when }) => {
        const client = await getClient();
        const result = await client.batchUpdateTodos(ids, operation, { when });
        return textResult(`Batch ${operation} applied to ${result.count} to-dos.`);
      }
    );

    // 29. things_search
    server.tool(
      "things_search",
      "Comprehensive search across to-dos, projects, headings, and notes with optional filtering.",
      {
        query: z.string().describe("Search keywords or phrase"),
        status: z.enum(["open", "completed", "all"]).optional().default("open").describe("Filter status"),
        include_notes: z.boolean().optional().default(true).describe("Include task notes in search"),
        area: z.string().optional().describe("Filter to specific Area title or UUID"),
        project: z.string().optional().describe("Filter to specific Project title or UUID"),
        tag: z.string().optional().describe("Filter to specific Tag name"),
      },
      async ({ query, status, include_notes, area, project, tag }) => {
        const client = await getClient();
        const db = await client.syncDatabase();
        const results = db.search(query, { status, includeNotes: include_notes, area, project, tag });
        return textResult(results);
      }
    );

    // 30. things_get_account_info
    server.tool(
      "things_get_account_info",
      "Fetch Things Cloud account details, Maildrop address, and database aggregate statistics.",
      {},
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

    // 31. things_manage_maildrop
    server.tool(
      "things_manage_maildrop",
      "Manage Things Cloud Maildrop email address (used to forward emails into your Things Inbox).",
      {
        action: z.enum(["get", "reset", "clear"]).describe("Action: 'get' current address, 'reset' to generate new address, or 'clear' to disable"),
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

    this.server = server;
  }
}
