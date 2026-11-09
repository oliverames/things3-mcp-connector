# Things 3 MCP Connector

A hosted OAuth remote [Model Context Protocol (MCP)](https://modelcontextprotocol.io) connector for Cultured Code's **Things 3**, deployed on Cloudflare Workers ([things3mcp.org](https://things3mcp.org)).

This connector talks directly to Things Cloud using its native wire format (`Task6`, `Area3`, `Tag4`, `ChecklistItem3`, schema 301) to read tasks and commit changes atomically via Things Cloud sync.

---

## Features

- **Full Things JSON Specification**: Complete compatibility with Cultured Code's Things JSON format (`things:///json`).
  - Batch create projects, sections/headings, to-dos, checklist items, and tags in a single atomic commit.
  - Honors all standard attributes: `completed`, `canceled`, `completion-date`, `creation-date`, `when`, `deadline`, `reminder-time`, `area-id`, `area`, `list-id`, `list`, `heading-id`, `heading`, and `tags`.
  - Dynamic container resolution: `list-id` and `list` automatically resolve to projects or areas. To-dos assigned to a container default to `"anytime"` scheduling rather than landing in the Inbox.
  - Update operations: Full support for `"operation": "update"` with `"id"` on to-dos and projects. Applies only specified fields and rejects non-existent IDs with an error without creating unwanted items.
  - Operation reporting: Clear per-item status (`created` vs `updated`) in results.
- **Date & Status Handling**:
  - Sets `creation_date` and `completion_date` via ISO 8601 strings (e.g., `2026-08-31T17:00:00Z` or `2026-08-31`).
  - Follows Things' rules: completion dates only apply to completed (`ss: 3`) or canceled (`ss: 2`) items (reset to null on open items), and neither creation date nor completion date can be in the future.
  - Supports all scheduling targets: `inbox`, `today`, `tomorrow`, `evening`, `anytime`, `someday`, or calendar dates `YYYY-MM-DD`.
- **Bulk Operations**:
  - `things_batch_update_todos`: Batch complete, cancel, trash, reschedule, or set dates (`completion_date`, `creation_date`, `deadline`) across multiple to-dos simultaneously.
  - `things_import_json`: Atomic multi-entity import and update in a single sync transaction.
- **Incremental Cached Sync**: Fast in-memory state with 15-second cache TTL, 429 rate limit backoff, and automatic pagination handling.
- **Security & OAuth**: Cloudflare Workers OAuth 2.0 provider integration with per-user credential encryption and rotated secrets.

---

## Tool Reference

### Import & Bulk Operations
- `things_import_json`: Import or update complex structured projects, headings, to-dos, checklists, and tags using Things JSON format in a single atomic sync commit.
- `things_import_csv`: Import tasks into Things 3 from CSV exports (supports Asana, Todoist, OmniFocus, and standard spreadsheet formats) with automatic mapping of titles, notes, due dates, creation dates, completion dates, and project/area assignment.
- `things_batch_update_todos`: Perform batch operations (`complete`, `cancel`, `trash`, `reschedule`, `set_dates`) across multiple to-do UUIDs.
- `things_batch_update_projects`: Perform batch operations (`complete`, `cancel`, `trash`, `reschedule`, `set_area`, `set_dates`) across multiple project UUIDs.

### To-Dos & Checklists
- `things_add_todo`: Create a new to-do with scheduling, reminder alert, deadline, container, checklist, and dates.
- `things_update_todo`: Update any property of an existing to-do, including `completion_date`, `creation_date`, status, notes, scheduling, and tags.
- `things_get_todo`: Fetch complete details of a specific to-do by UUID or exact title.
- `things_complete_todo`: Mark a to-do as completed.
- `things_cancel_todo`: Mark a to-do as canceled.
- `things_trash_todo`: Move a to-do to Trash.
- `things_delete_todo`: Move a to-do to Trash or permanently purge it.
- `things_duplicate_todo`: Duplicate an existing to-do.
- `things_move_todo`: Move a to-do to a different schedule, project, heading, or area.
- `things_convert_todo_to_project`: Convert a to-do into a project, turning checklist items into to-dos.
- `things_set_checklist`: Atomically replace the entire checklist of a to-do with a new list of items.
- `things_add_checklist_items`: Append checklist items to a to-do.
- `things_update_checklist_item`: Mark a checklist item completed/canceled or rename it.
- `things_delete_checklist_item`: Delete a checklist item.

### Projects & Headings
- `things_create_project`: Create a new project with area, deadline, scheduling, and tags.
- `things_update_project`: Update project properties including `completion_date`, `creation_date`, title, notes, area, deadline, and status.
- `things_get_projects`: List projects filtered by status (`open`, `completed`, `all`) and area.
- `things_get_project`: Fetch details of a project including headings, nested tasks, and completion dates.
- `things_get_project_stats`: Progress statistics across projects (velocity, completion %, overdue project counts).
- `things_create_heading`: Create a section heading inside a project.
- `things_update_heading`: Rename or delete a section heading.

### Lists & Views
- `things_get_today`: Retrieve Today's to-dos.
- `things_get_inbox`: Retrieve unorganized Inbox to-dos.
- `things_get_upcoming`: Retrieve future scheduled tasks and deadlines.
- `things_get_anytime`: Retrieve Anytime tasks filtered by area or tag.
- `things_get_someday`: Retrieve Someday tasks.
- `things_get_logbook`: Retrieve completed or canceled items sorted by completion date, with optional `since` and `until` date filtering.
- `things_get_trash`: Retrieve trashed items.
- `things_get_repeating`: Retrieve repeating templates.

### Tags, Areas & Account
- `things_create_area` / `things_update_area` / `things_delete_area` / `things_get_areas`: Full lifecycle management of Areas of Responsibility.
- `things_create_tag` / `things_update_tag` / `things_delete_tag` / `things_get_tags` / `things_add_tags` / `things_remove_tags`: Full lifecycle tag management including shortcuts and hierarchy.
- `things_empty_trash`: Permanently purge all trashed items.
- `things_export_markdown`: Export an entire project or Inbox to formatted Markdown.
- `things_get_deep_link`: Generate a `things:///show?id=...` URL.

### Prompts & Workflow Guides
- `daily-planning`: Interactive planning session reviewing today's agenda, upcoming deadlines, and inbox triage.
- `weekly-review`: Complete Getting Things Done (GTD) weekly review routine.
- `project-breakdown`: Decompose milestone goals into structured projects with headings, actions, and checklists.
- `asana-migration-audit`: Step-by-step guidance and verification for migrating from Asana to Things 3.

---

## Development & Testing

```bash
# Run test suite
npm test

# Run local development server
npm run dev

# Deploy to Cloudflare Workers
npm run deploy
```

---

## License

MIT
