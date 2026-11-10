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
- **Security & OAuth**: Cloudflare Workers OAuth 2.0 provider integration. Things credentials are stored once, inside the grant, encrypted with AES-256-GCM under a key derived from the `DATA_ENCRYPTION_KEY` secret with HKDF-SHA-256 (see Behavior Notes).

---

## Tool Reference

### Import & Bulk Operations
- `things_import_json`: Import or update complex structured projects, headings, to-dos, checklists, and tags using Things JSON format in a single atomic sync commit.
- `things_import_csv`: Import tasks into Things 3 from CSV exports (supports Asana, Todoist, OmniFocus, and standard spreadsheet formats) with automatic mapping of titles, notes, due dates, creation dates, completion dates, and project/area assignment.
- `things_batch_update_todos`: Perform batch operations (`complete`, `cancel`, `trash`, `reschedule`, `set_dates`) across multiple to-do UUIDs. A field the operation does not use is an error.
- `things_batch_update_projects`: Perform batch operations (`complete`, `cancel`, `trash`, `reschedule`, `set_area`, `set_dates`) across multiple project UUIDs. A field the operation does not use is an error.

### To-Dos & Checklists
- `things_add_todo`: Create a new to-do with scheduling, reminder alert, deadline, container, checklist, and dates. The `repeat` option creates a repeating to-do (see Behavior Notes).
- `things_update_repeat`: Edit the rule of a repeating to-do, pause it, resume it, or stop it (see Behavior Notes).
- `things_update_todo`: Update any property of an existing to-do, including `completion_date`, `creation_date`, status, notes, scheduling, and tags.
- `things_get_todo`: Fetch complete details of a specific to-do by UUID or exact title.
- `things_complete_todo`: Mark a to-do as completed.
- `things_cancel_todo`: Mark a to-do as canceled.
- `things_delete_todo`: Move a to-do to Trash or permanently purge it. Only to-do ids are accepted.
- `things_duplicate_todo`: Duplicate an existing to-do, including the checked state of its checklist.
- `things_move_todo`: Move a to-do to a different schedule, project, heading, or area. Moving to Inbox, Anytime, or Someday clears the reminder time.
- `things_convert_todo_to_project`: Convert a to-do into a project, turning checklist items into to-dos.
- `things_set_checklist`: Atomically replace the entire checklist of a to-do with a new list of items.
- `things_add_checklist_items`: Append checklist items to a to-do.
- `things_update_checklist_item`: Mark a checklist item completed/canceled or rename it.
- `things_delete_checklist_item`: Delete a checklist item.

### Projects & Headings
- `things_create_project`: Create a new project with area, deadline, scheduling, and tags.
- `things_update_project`: Update project properties including `completion_date`, `creation_date`, title, notes, area, deadline, and status. Completing or canceling a project closes its open to-dos with it (see Behavior notes).
- `things_get_projects`: List projects filtered by status (`open`, `completed`, `all`) and area.
- `things_get_project`: Fetch details of a project including headings, nested tasks, and completion dates.
- `things_get_project_stats`: Progress statistics across projects (velocity, completion %, overdue project counts).
- `things_create_heading`: Create a section heading inside a project.
- `things_update_heading`: Rename or permanently delete a section heading.

### Lists & Views
- `things_get_today`: Retrieve the Today list as Things shows it: start dates that have arrived, plus undated to-dos whose deadline is today or overdue. Takes an optional `timezone`.
- `things_get_inbox`: Retrieve unorganized Inbox to-dos.
- `things_get_upcoming`: Retrieve future scheduled tasks and future deadlines. Takes an optional `timezone`.
- `things_get_anytime`: Retrieve Anytime tasks filtered by area or tag.
- `things_get_someday`: Retrieve Someday tasks.
- `things_get_logbook`: Retrieve completed or canceled items sorted by completion date, with optional `since` and `until` filtering. A bare `YYYY-MM-DD` is a calendar day in the connector's time zone, or in `timezone` when given.
- `things_get_trash`: Retrieve trashed items.
- `things_get_repeating_todos`: Retrieve repeating templates with their rule in words.

### Tags, Areas & Account
- `things_create_area` / `things_update_area` / `things_delete_area` / `things_get_areas`: Full lifecycle management of Areas of Responsibility.
- `things_create_tag` / `things_update_tag` / `things_delete_tag` / `things_get_tags` / `things_add_tags` / `things_remove_tags`: Full lifecycle tag management including shortcuts and hierarchy.
- `things_empty_trash`: Permanently purge all trashed items. A trashed project or heading is purged with everything inside it.
- `things_get_account_info`: Account status, Maildrop address, and database counts. The history key is not returned.
- `things_manage_maildrop`: Get, reset, or clear the Maildrop address. Reset and clear invalidate the current address for good.
- `things_get_daily_summary` / `things_get_deadlines` / `things_search`: Daily briefing, deadline overview, and search (trashed items, headings, and repeating templates are not searched). The first two take an optional `timezone`.
- `things_export_markdown`: Export an entire project or Inbox to formatted Markdown.
- `things_get_deep_link`: Generate a `things:///show?id=...` URL.

### Prompts & Workflow Guides
- `daily-planning`: Interactive planning session reviewing today's agenda, upcoming deadlines, and inbox triage.
- `weekly-review`: Complete Getting Things Done (GTD) weekly review routine.
- `project-breakdown`: Decompose milestone goals into structured projects with headings, actions, and checklists.
- `asana-migration-audit`: Step-by-step guidance and verification for migrating from Asana to Things 3.

---

## Behavior Notes

- **Each tool accepts only its own kind of item.** To-do tools refuse project and heading ids, project tools refuse to-do ids, and the permanent-delete tools refuse any id that is not the kind they name. Giving `things_delete_checklist_item` the parent to-do's id deletes nothing.
- **Dates must exist.** `2027-02-31` is an error, not March 3.
- **A reminder needs a date.** `reminder_time` with no `when` schedules the to-do for today; with `inbox`, `anytime`, or `someday` it is refused. Moving a to-do to one of those lists clears its reminder. `null` or `""` removes a reminder or a deadline. A reminder at exactly 00:00 cannot be stored.
- **Project plus heading.** When both are given, the heading must belong to that project and the to-do is filed under it. A heading of another project is refused.
- **Today** lists open to-dos whose start date is today or earlier (including scheduled to-dos the Things apps have not yet moved into Today) and to-dos with no start date whose deadline is today or overdue. To-dos inside a trashed, completed, or canceled project are not listed as live anywhere.
- **Closing a project closes its to-dos.** As in the Things app, completing a project completes every open to-do in it, including those under its headings, and canceling it cancels them. This happens in the same commit, with the project's completion date, through `things_update_project`, `things_batch_update_projects`, and a `things_import_json` update, and the result says how many to-dos were closed. To-dos that are already completed, canceled, or trashed, headings, and repeating templates are not touched. Reopening a project does not reopen its to-dos.
- **Repeating to-dos.** A template is returned with `"repeating": true`, `"when": "repeating"`, `"repeatRule"` (for example "Every week on Monday") and a `"repeat"` object (frequency, interval, mode, next occurrence, end, deadline offset, and `paused`, which is `true` while the repeat is paused). Its `deadline` is `null`; a template with deadlines turned on says so in the rule. Templates are left out of lists, search, and project counts; `things_get_project` returns them separately as `repeatingTemplates`. The to-dos a template generates carry `"repeatTemplateId"`.
- **Creating a repeating to-do.** `things_add_todo` takes a `repeat` object and writes one hidden template; the Things apps generate the to-dos from it. Supported rules are the ones recorded from the Things app: daily and every N days; weekly on chosen weekdays, every N weeks; monthly on day(s) of the month, on the last day, or on the 1st to 4th or last weekday; yearly on a date or on the 1st to 4th weekday of a month; after completion every N days; ending never, on a date, or after N times. Anything else is refused with a message that lists these (no deadlines or reminder times on a repeat, no weekly, monthly, or yearly after-completion rule). `repeat.starts` is the first day and defaults to the next day the rule falls on, counting today. A given start must be a day the rule falls on and not in the past. `when` may be left out or name the same first day (`today`, `tomorrow`, or a date); any other `when`, or a `when` that disagrees with `repeat.starts`, is refused.
- **Editing, pausing, and stopping a repeat.** `things_update_repeat` takes the template id, or the id of one of its occurrences, and one `action`. Each action writes only what Things 3.24.2 was recorded writing for it, and refuses anything else.
  - `rule` replaces the rule with a `repeat` object (the same options as `things_add_todo`). If the new rule falls on the repeat's current next day, only the rule is written and the next day stays where it is. If it does not, the next day moves to the first day on or after it that the new rule falls on, and never to a day before today. `repeat.starts` may name the new next day instead: it must be on or after the current next day, not in the past, and a day the rule falls on. The result gives the next day and says whether it moved. Also refused: a paused repeat (resume it first), a rule that repeats after completion on either side of the edit, and a repeat with a deadline offset.
  - `pause` and `resume` switch the creation of new occurrences off and on. Pausing a paused repeat writes nothing.
  - `stop` ends the repeat in one commit: the template is deleted, every open occurrence becomes an ordinary to-do, and a plain to-do is created for the next day with the template's title, notes, tags, checklist items (each keeping its status), and project, heading, or area. Completed, canceled, and trashed occurrences are left alone. Stop is refused when the template is paused, adds deadlines or reminders, or has a next day that is not in the future. Trashing the template with `things_delete_todo` also ends a repeat and is the alternative in those cases.
- **Filters** (`area`, `project`, `tag`) take an id or a title, case-insensitively. An unknown name is an error, not an empty list.
- **Tags** have unique titles and cannot be nested in a cycle.
- **`things_import_json` updates.** `checklist-items` replaces the checklist, `append-checklist-items` adds to it, `add-tags` adds tags, and two updates for the same id are merged into one change.
- **`things_import_csv`** files rows into projects, areas, and headings that already exist. It creates to-dos only.
- **Login pages** escape every value they show and are served with a Content-Security-Policy that allows no scripts.
- **Concurrent edits.** When Things Cloud rejects a commit because another device committed first, the connector syncs and tries again. Anything it computed from the old state is computed again from the new one before the retry: the full tag list of an item when a tag is added, removed, or deleted, the position of new checklist items, the checklist being replaced, the open to-dos of a project being closed, the contents of an area being deleted or a Trash being emptied, appended notes, and a whole `things_import_json` plan. A tag another device added in between is therefore kept. A plain field change (a new title, for example) is resent as it was. New items keep the same ids across retries, so a retry cannot create a duplicate. If the rebuilt change is no longer possible (the item was deleted in between), the call fails and nothing is written. Emptying the Trash after a conflict purges only what was in the Trash when the tool was called and is still there.
- **Batch fields.** Each batch operation takes only its own fields, and any other field is an error that names it, with nothing written. For to-dos: `complete` and `cancel` take `completion_date`; `trash` takes none; `reschedule` takes `when`; `set_dates` takes `deadline`, `completion_date`, `creation_date`. Projects are the same, plus `set_area` with `area`, and `set_dates` also takes `when` and `area`.
- **Closed projects.** A new open to-do cannot be filed into a completed or canceled project, or under one of its headings: it would be hidden in the Logbook with the project. The error names the project. A to-do created as completed or canceled is accepted there, so finished work can be imported into a finished project. Importing a completed project together with open to-dos inside it is refused for the same reason.
- **Time zone.** "Today" is the calendar day in `USER_TIMEZONE` (America/New_York). `things_get_today`, `things_get_upcoming`, `things_get_deadlines`, `things_get_daily_summary`, and `things_get_logbook` take an optional `timezone` (an IANA name such as `Europe/Paris`; an unknown name is an error) to answer for another zone in that one call. Writes always use the configured zone: `when: "today"` means today in `USER_TIMEZONE`.
- **Stored credentials.** The Things email and password are stored once, encrypted, in the OAuth grant. The provider deletes them with the grant when it is revoked, and when a new sign-in by the same user and client replaces it. The key is derived from `DATA_ENCRYPTION_KEY` with HKDF-SHA-256. Records written with the earlier key (the first 32 characters of the secret) still open, and are re-encrypted the next time the grant gets a token. Grants made before 2026-11-09 also kept a copy in a per-grant Durable Object; that copy is deleted the next time the grant gets a token. The sign-in form checks for a pending authorization request before it sends the password to Things Cloud.

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
