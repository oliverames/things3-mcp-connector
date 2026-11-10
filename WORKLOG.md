# Things MCP connector worklog

## 2026-11-10 - Session closeout

**What changed**: The audit fixes, repeat create, `things_update_repeat`, project close, conflict rebuild, credential storage and import changes recorded below are all deployed (Worker `a295a3e1`, head `c7d5552`). CI had been failing since `8ce82b1` because the tests import `hono` and the workflow installed nothing; it now runs `npm ci`. Related repo: `things-reminders-sync` v0.2.3.

**Verification**: 114 tests pass. Verified live against Things 3.24.2: repeat create, rule edit (with and without a moved next day), pause, resume, stop with notes, tags and checklist, project close, finished-project import, sign-in after the password and credential changes, and an invalid `timezone` being refused.

**Left off at**: Nothing in progress. Test projects are in the Things Trash.

**Open questions**:
- NEW: password escaping for special characters (issue #4).
- Still open: Maildrop `clear` and `empty_trash` on a trashed project with contents (issue #1); Upcoming and the `update_area` schema (issue #2).
- NEW: the things-3 skill reference does not yet describe the finished-project import (personal-plugins issue #25).
- Resolved this session: issue #3 (create repeating to-dos).

---

## 2026-11-10 - Importing a finished project, and a note on tag titles (commit `acb2f6c`, deployed as Worker `a295a3e1`, verified live)

Nothing was written to Things Cloud and nothing was deployed; the work is covered by tests against the mocked fetch only.

**Importing a finished project** (`planImport` in `src/things-client.js`)
- Since 8ce82b1 the validator refuses a new open to-do in a completed or canceled project, so `things_import_json` refused a completed or canceled project that listed open to-dos.
- When an import creates a project as completed or canceled, each to-do created in it with no completed or canceled status of its own is now created with the project's status and stop date. This covers to-dos listed in the project's `items`, those under its headings, and a later top-level to-do in the same import that names the new project or one of its headings.
- The write is the create `buildTaskCreate` already produces for a to-do created completed or canceled, with `sp` set to the project's `sp`. No new shape is written. Headings and checklist items are created as before.
- A to-do with its own completed or canceled status keeps its status and stop date.
- The result carries `todosClosedWithProject` for the import and `todosClosed` on the item of each project created closed.
- A new open to-do filed into a project that was already completed or canceled is still refused by the validator.
- `things_import_csv` creates to-dos only, so it needed no change.

**Tag titles and Apple Reminders** (`src/things-mcp.js`)
- The descriptions of `things_create_tag` and `things_update_tag` now say that a tag title with spaces is fine in Things and is matched to its Reminders hashtag with the spaces removed. No behavior changed.

**Tests**: 114 pass (`npm test`). The new test covers a completed project with open, completed, canceled, and heading to-dos, a top-level to-do filed into it by title, a canceled project with no completion date, the counts in the result, an open project, and the refusal for an existing closed project.

**Not verified**: the Things apps reading these creates from a live account.

## 2026-11-09 - Repeat rule edit that moves the next day, and stop with notes, tags, and checklist items (commit `63f8ead`, deployed, verified live)

Source: the second sampling session in the orchestrating session's `repeat-edit-shapes.md` (Things 3.24.2, history indexes after 1716). Nothing was written to Things Cloud and nothing was deployed; the work is covered by tests against the mocked fetch only.

**Rule edit that moves the next day** (`planRepeatUpdate` in `src/things-client.js`)
- The `rule` action no longer refuses a rule that does not fall on the template's `tir`. The new next day is `repeat.starts` when given, otherwise the first day the new rule falls on, counted from the old `tir` or from today when the old `tir` is in the past.
- The write is one update on the template: `{ rr, md, icsd, tir }`. `rr` keeps the old `rr.sr`, `rr.ia` is the template's `tir` before the edit, and `tir` and `icsd` are both the new next day. `ti` and `icc` are not written. The recorded update also carried `ti`, which the app happened to rewrite.
- When the new rule falls on the current `tir` and `repeat.starts` is absent or names that day, the write is still `{ md, rr }`.
- The result carries `nextOccurrence`, `previousNextOccurrence`, and `nextDayMoved`.
- Removed `repeatDaysNear`, which only served the old refusal message.

**Stop with notes, tags, and checklist items**
- The second record confirms that the new to-do gets the template's notes (with the CRC-32 in `nt.ch`) and tags, which `buildRepeatStopCreate` already wrote.
- New `buildRepeatStopChecklistCreate`. Each checklist item of the template is created again for the new to-do with `lt` true, `md` null, `cd` equal to the new to-do's `cd`, `ts` the new to-do, the recorded `xx`, `ss` and `sp` carried over, and `ix` counting from 0 in the template's order. The template's own items are tombstoned. Commit order as recorded: the new to-do, the new items, the item tombstones, the detached occurrences, the template tombstone.
- The refusal for a template with checklist items is gone. New ids come from one ordered pool, so a plan rebuilt after a conflict names the same items.

**Refusals that remain**
- `rule`: a paused template; an after-completion rule on either side; an old rule that is not a plain rule (for example a deadline offset in `ts`); a template with no `tir`; `repeat.starts` before the current next day, in the past, or on a day the rule does not fall on; an end date before the new next day.
- `stop`: a paused template; `ato` or the deadline sentinel in `dd`; a `tir` that is today, past, or missing.
- Any action on a trashed template or on a to-do that is neither a template nor an occurrence.

**Validator**
- A template update with `rr` must be exactly `{ md, rr }` or exactly `{ md, rr, tir, icsd }`. `tir` and `icsd` stay refused on a template in any other update. In both forms `rr.sr` is the old `sr` and `rr.ia` is the old `tir`. The four-key form also needs `tir` equal to `icsd`, later than the old `tir`, not before today, on a day the new rule falls on, and not after the rule's end date. The two-key form still needs the rule to fall on the old `tir`.
- A checklist create with `lt` true or `md` null, or one whose parent is a stop create, must have `lt` true, `md` null, a stop create in the same commit as its parent, and that create's `cd`.
- A stop create must come with the template's checklist items, one for one: same title, `ss`, and `sp`, and `ix` 0, 1, 2 in the template's order. The existing dangling-reference check already refuses a commit that leaves the template's own items behind.

**Tests**: 113 pass (`npm test`). Both recorded commits are compared key for key with the clock set to the recorded write (`md` and `cd` to the millisecond). Also covered: `repeat.starts` naming a later day, a `tir` in the past, status and stop date carried to the new items, and the validator refusing each near miss of both shapes.

**Differences from the records**
- `ti` is left out of the rule edit, as instructed.
- Entities are written as `Task6`, like every other write of the connector; the app wrote `Task7`.
- The ids of the new to-do and items are generated, and timestamps have millisecond precision.

**Not verified**
- Nothing here has been read by a Things app. One supervised live run of each shape is still needed.
- The move was recorded once, with an interval of 1 and no `repeat.starts`. Whether the app would pick the same next day for an interval above 1, and whether it accepts a later day chosen with `repeat.starts` when the rule also falls on the current next day, is not known.
- Which of the two recorded template items was "One" is not in the record, and their `ix` values are not either. `ix` counting from 0 matches the record but a template whose items have other `ix` values was not recorded.
- Items with a status other than open were not recorded; `ss` and `sp` are carried over as instructed.

## 2026-11-09 - Remaining hardening items from the audit (commit `8ce82b1`, deployed)

These five were declined in the audit pass as small benefit and are now done. Nothing was written to Things Cloud and nothing was deployed; all of it is covered by tests against a mocked fetch. No new wire shape is written: every change sends the same entities and keys as before.

**1. Read-modify-write after a conflict** (`src/things-client.js`). `commitChanges` takes either a list of change maps (a plain patch, resent unchanged as before) or a builder `(db) => list`. A builder runs against the synced database and runs again against the refreshed one before every resend, after a 409 or 412 and after a 5xx whose commit the history shows did not land. Validation, the "did it land" check, and the retry limit are unchanged. Builders mint ids and timestamps outside themselves, so every run names the same new items. Now builders: `updateTask` (so `updateTodo`, `updateProject`, `moveTodo`, and closing a project), `addTagsToTask` and `removeTagsFromTask` (through the new `retagTask`), `deleteTag` and `deleteEntity` (the `purgeChanges` cascade), `deleteArea`, `emptyTrash`, `addChecklistItems`, `setChecklist`, `convertTodoToProject`, both batches (`commitBatch`), `updateRepeat` (planned in `planRepeatUpdate`), and `importJson` (planned in `planImport`, ids from one ordered pool). Still plain lists: creates, and the single-field updates of headings, areas, tags, and checklist items. If a rebuild throws (the item is gone), the error says Things changed and nothing was written. `emptyTrash` rebuilt after a conflict purges only what was trashed at the first read and still is.

**2. Batch fields.** `batchOptions` checks the options of `batchUpdateTodos` and `batchUpdateProjects` against a table per operation. A field the operation does not use is an error naming it, and so is an unknown operation. Before, `when` and `deadline` were applied on every operation. The tool descriptions list the fields per operation.

**3. Closed projects.** The validator refuses the create of an open to-do whose project, directly or through its heading, is completed or canceled, and names the project. It runs on the state after the commit, so it also covers imports and retries. Allowed: a to-do created completed or canceled, and the to-do a stopped repeat leaves behind.

**4. OAuth and stored credentials.**
- (a) New `src/credential-crypto.js` (pure WebCrypto, importable in Node; `src/oauth-storage.js` re-exports from it). The AES-256-GCM key is derived with HKDF-SHA-256 from the whole secret. Decryption tries the derived key, then the old one (first 32 characters, zero-padded). The Durable Object record is re-encrypted on its first read (`readStoredCredentials`). The copy in the grant props is re-encrypted by `upgradeGrantProps`, called from the provider's `tokenExchangeCallback` in `src/index.js`, which returns `newProps`.
- (b) The provider has no revocation hook. Instead the credentials now live only in the grant props, which the provider deletes with the grant on revocation and on replacement (`completeAuthorization` revokes earlier grants of the same user and client by default). `src/things-handler.js` no longer writes the per-grant Durable Object and no longer puts `grantId` in the props. For older grants, `upgradeGrantProps` deletes the Durable Object copy and drops `grantId` the next time the grant gets a token, once the props are known to hold readable credentials. The Durable Object class and its read fallback stay for grants that have no encrypted props.
- (c) `POST /authorize/login` now resolves the OAuth request (consent record, or a valid authorization request rebuilt from the form) before it contacts Things Cloud. Without one it answers 400 and the password is not sent anywhere.

**5. Time zone.** `ThingsDatabase.inTimeZone(zone)` returns a read-only copy in another zone, validated by `assertTimeZone`. `things_get_today`, `things_get_upcoming`, `things_get_deadlines`, `things_get_daily_summary`, and `things_get_logbook` take an optional `timezone`. The client, the validator, and every write keep `USER_TIMEZONE`.

**Verification**: `npm test` passes 111 tests (99 before). One existing test changed: an update whose project was deleted during a conflict is now refused by the rebuild ("No project found ... nothing was written") instead of by the validator; a new test keeps the validator case for a plain list.

**Not verified**
- Nothing ran in the Workers runtime. `src/index.js`, `src/things-mcp.js`, and `src/oauth-storage.js` import `cloudflare:workers` or the agents package and were only syntax-checked. The `tokenExchangeCallback` wiring (it reads the env recorded by `fetch`, and returns `newProps`) and the `timezone` argument at the tool layer need a `wrangler dev` or deployed check.
- Whether Things Cloud answers a stale `ancestor-index` with 409 or 412 is still an assumption from the audit.

**Open**
- Durable Object copies of grants that were revoked or replaced before this change cannot be found: they are named by a random id that only the deleted grant knew. Removing them means deleting the `OAuthCredentials` class in a migration once no old grant is left, which is the owner's call.
- The sign-in form still tells a caller whether a password is right when the caller holds a valid authorization request, and anyone can make one through open client registration. Closing that needs rate limiting or closed registration, not a reorder.
- `updateTag` and `createTag` check title uniqueness against the first read only. A tag with the same title created by another device during a conflict is not caught on the retry.

---

## 2026-11-09 - Repeat rule edit, pause, resume, and stop (commit `1d73aa6`, deployed, verified live)

Source: the shapes Things 3.24.2 wrote on 2026-11-09 (history indexes 1688 to 1700), recorded in the orchestrating session's `repeat-edit-shapes.md`. Nothing was written to Things Cloud; the work is covered by tests against the mocked fetch only.

**Tool**: `things_update_repeat` takes `id` (the template, or an occurrence, which is resolved through `rt`), one `action`, and `repeat` for the `rule` action. `ThingsCloudClient.updateRepeat` in `src/things-client.js` does the work.

**Writes** (all `Task6`, like every other write of the connector; the app itself wrote `Task7`)
- `rule`: one update on the template, `{ md, rr }`. `rr` is `buildRepeatRule(repeat, next day)` with `sr` replaced by the old rule's `sr`, so `ia` is the template's `tir`. `tir`, `icsd`, and `icc` are not written.
- `pause` and `resume`: one update on the template, `{ icp: true | false, md }`.
- `stop`: one commit with three kinds of entry, in the recorded order. A create from `buildRepeatStopCreate` with every key and value of the recorded create (`lt` true, `md` null, `icsd` null, `rr` null, `st` 2, `sr` = `tir` = the template's `tir`), with title, notes, tags, `pr`, `agr`, `ar`, and `ix` copied from the template and `cd` set to now. Then `{ rt: [] }` with no `md` on every open, untrashed occurrence. Then the template tombstone (`t` 2, empty `p`).

**Refusals**, each because the shape was not recorded
- `rule`: the new rule does not fall on the template's `tir`, or `repeat.starts` names another day (the message names the nearest days the rule falls on); the template is paused; the old or new rule repeats after completion; the old rule is not a plain rule (for example a deadline offset in `ts`); the template has no `tir`.
- `stop`: the template has checklist items, is paused, has `ato` or the deadline sentinel in `dd`, or has a `tir` that is today, past, or missing. The messages name trashing the template as the alternative.
- Any action on a trashed template, on a to-do that is neither a template nor an occurrence, and `repeat` given with an action other than `rule`.

**Validator**
- `TEMPLATE_SAFE_KEYS` gained `rr` and `icp` only. An `rr` update on a template must be exactly `{ md, rr }` on an unpaused template, fixed schedule to fixed schedule, with `rr.sr` unchanged, `rr.ia` equal to `tir`, and a rule that falls on the `tir` day. An `icp` update must be exactly `{ icp, md }`, `icp` must be a boolean, and it is refused on anything that is not a template.
- An occurrence may write `{ rt: [] }` and nothing else, only when it is open and untrashed and the same commit tombstones its template.
- The recorded stop create passed the existing shape checks as it was: `md` null and `lt` true were already accepted on a create. The validator was tightened instead. A to-do create with `lt` true or `md` null must now have every fixed value of the recorded create, and must come with the tombstone of exactly one template whose `tir` is its `sr`.
- One check was loosened: in a commit that holds a stop create, completed, canceled, and trashed occurrences may keep naming the tombstoned template in `rt`. Without a stop create the old refusal stands, and an open occurrence that is not detached is still refused.

**Reads**: `repeat.paused` is on every template (`icp` is now decoded). Tool descriptions and the README no longer say a rule cannot be edited or cleared.

**Tests**: 99 pass. The clock is set to each recorded write, so the committed change maps are compared with the recorded entries key for key, `md` and `cd` to the millisecond (the records carry microseconds). Covered: rule, pause, resume, and stop against the recorded history; an occurrence id resolving to its template; stop with two open occurrences, one completed, and one trashed; every refusal above; the validator refusing each near miss.

**Not verified**
- Nothing here has been read by a Things app. One supervised live run of each action is still needed.
- The records hold one case per action. Not recorded: a rule edit with an end date or count (allowed, the `rr` shapes are the recorded create shapes), a stop with a completed or trashed occurrence present (they are left alone on the orchestrator's instruction), a stop on a template with tags, notes, a heading, or an area (copied on instruction; the record had a project and none of the others), and `Task6` against the recorded `Task7`.

## 2026-11-09 - Password encoding and closing a project's to-dos (commit `3eaff0d`, deployed as Worker `9bb2877b`, both verified live)

**Password encoding**: `ThingsCloudClient.encodePassword` ran `encodeURIComponent` and then escaped a character class that included `%`, so it escaped its own percent signs and `@` became `%2540`. It now escapes once and adds only `!*'()`, which is exactly what the Swift client in things-reminders-sync does: `p@ss w!rd*'()~` becomes `p%40ss%20w%21rd%2A%27%28%29~`. Which form Things Cloud itself wants is unverified. The owner's password has no special characters, so every form signs in, and no sign-in with a special character has been tried.

**Closing a project**: completing or canceling a project used to leave its open to-dos open, hidden by the read side. The Things app closes them with the project, and the connector now does the same in the one commit that closes the project. `projectCloseChanges` in `src/things-client.js` adds an update `{ md, ss, sp }` for every open, untrashed to-do in the project or under its headings, with the project's own `md`, `ss` (3 or 2), and `sp`, so a `completion_date` on the project is also the stop date of those to-dos. These are the keys a single to-do completion writes. To-dos already completed, canceled, or trashed, to-dos under a trashed heading, headings, and repeating templates are not touched. Reopening a project reopens nothing. It applies to `things_update_project`, `things_batch_update_projects` (complete and cancel), and a `things_import_json` update. In an import, a to-do that the same import already created or updated takes the status in that one change, since a commit holds one change per id. Results report `todosClosed`, and the tool text says how many open to-dos were closed with each project. Tool descriptions and the README say so.

**Verification**: `npm test` passes 93 tests. The new ones run against the mocked fetch: open children closed with the project, heading children included, completed, canceled, and trashed children and templates untouched, cancel cancels, a completion date carried to the children, reopen and trash leave children alone, and the import path. Every commit in them passes `validateChangeMap`. Nothing was written to Things Cloud, so the Things apps have not been seen reading these commits, and the claim about what the Things app writes for the children (keys and timestamp) rests on the task description, not on a recorded sample.

## 2026-11-09 - Creating repeating to-dos, issue #3 (commit `1ca7a2f`, deployed as Worker `9c6ca148`)

Source: `docs/RECURRENCE.md` in things-reminders-sync (rules recorded from Things 3.24.2) and the Swift `rr(for:)` and template create there. Nothing was written to Things Cloud; the work is covered by tests only.

**Writes**
- `buildRepeatRule(repeat, start)` in `src/things-client.js` builds `rr` in the recorded key order (`fu, fa, of, tp, ia, sr, rc, ts, rrv, ed`). Shapes: daily, weekly on weekdays, monthly on day(s), last day, or nth or last weekday, yearly on a date or nth weekday of a month, after completion in days, and the three endings (never, on a date, after N times, which drops `ed`). Anything else is refused with one message that lists what is supported. There is no deadline option and no reminder time, because no template with those was recorded.
- `things_add_todo` takes `repeat`. It writes one `Task6` create: the ordinary Someday create plus `tir = icsd = rr.sr = first day` and `rr` (`st 2, sb 0, sr null, ato null, dd null, icc 0`). No occurrence is written; the Things apps generate them.
- `when` and `repeat`: the first day is `repeat.starts`, or the next day the rule falls on counting today. A given start must fall on the rule and not be in the past; the error names the next matching day. `when` may be omitted or name the same day (today, tomorrow, a date). Inbox, anytime, someday, evening, a disagreeing `when`, a reminder time, a deadline, and a completed or canceled status are refused.
- Validator: a create that carries `rr` must have exactly the template fields above, with `tir`, `icsd`, and `rr.sr` on one day, and cannot start before today. `repeatRuleProblems` still runs on every rule. Nothing was loosened; updates to a template are as restricted as before.
- No rule edit and no rule clear. The tool descriptions say so, and that trashing the template stops it.

**Tests**: each of the 15 recorded rules is compared as a JSON string with the builder output for the recorded start (2026-11-09). Also: template fields, validator refusals, first-day selection, refusals for unsupported shapes, and a create through the mocked cloud that reads back with `repeating: true` and the rule in words. 87 tests pass.

**Not verified**: that the Things apps generate to-dos from a template written by the connector. That needs one supervised live create.

---

## 2026-11-09 - Audit fixes: delete guards, login page escaping, Today and repeating reads (commit `1ca7a2f`, deployed as Worker `9c6ca148`)

Source: the read-only connector audit and the Swift/JavaScript write parity audit of the same day. Each finding was reproduced against the code first: every new test fails on `8e36a3d` and passes now.

**Writes**
- The permanent-delete paths take the kind they are allowed to delete. `things_delete_checklist_item` with a to-do id, `things_delete_todo` with a project, heading, area, tag, or checklist id, and `things_update_heading delete` with a project id are refused with nothing written. `deleteEntity` no longer works without a kind.
- To-do tools (`update`, `complete`, `cancel`, `move`, `delete`, `duplicate`, the to-do batch) refuse project and heading ids; project tools refuse to-do ids. The error names what the id is.
- A tag parent that would make a tag its own ancestor is refused by the validator. A tag title that already exists (any case) is refused.
- Impossible calendar dates are refused in `dateToTimestamp`.
- `when` of inbox, anytime, or someday writes `ato: null`, as the Swift writer does. The validator now checks "a reminder needs a start date" whenever `sr` or `ato` changes. A reminder together with an undated `when` is refused; a reminder with no `when` on a new to-do schedules it for today, and the reply says so. `reminder_time` and `deadline` accept `null` or `""` to clear. 00:00 gets its own message.
- Converting an Inbox to-do to a project also writes `st 1, sb 0`. The validator refuses a project at `st 0`.
- Project plus heading: the heading is resolved among that project's headings and the to-do is filed under it (`agr: [heading], pr: []`); a heading of another project is refused. The same holds for `list` plus `heading` in `import_json` and CSV rows. A heading whose project is trashed can no longer be a target.
- Lone surrogates are refused in `tt` of every entity, in `nt.v`, and in `sh`.
- `commitLanded` counts an update as ours only when the history item carries the properties we sent, so another client's edit to the same id after a 5xx leads to a resend instead of a false "done".
- `things_empty_trash` purges a trashed project or heading together with everything inside it (Things leaves `tr: false` on those children and removes them with the project). A project that is not trashed still cannot be purged from under live to-dos. The reply separates trashed items from contained ones.
- `import_json` updates: two updates for one id are merged, `checklist-items` replaces the checklist, `append-checklist-items` and `add-tags` are applied, `reminder` and `reminder-time` are honored, and `prepend-checklist-items` is an error instead of a silent drop.
- `things_duplicate_todo` keeps checklist state and refuses repeating templates. The project batch refuses `set_dates` with nothing to set.

**Reads**
- Today: open to-dos whose start date has arrived at `st 1` or `st 2`, plus to-dos with no start date whose deadline is today or overdue and was not dismissed (`dds` null). Decision on overdue deadlines: they are in Today, because that is where the Things app shows them; Upcoming now lists future deadlines only. To-dos in a trashed project or under a trashed heading, and open to-dos in a completed or canceled project, are not listed as live.
- Repeating templates: `"repeating": true`, `"when": "repeating"`, `repeatRule` in words, a `repeat` object, `deadline: null` (the 4001-01-01 sentinel no longer appears; the rule says when deadlines are on and how many days before the deadline the to-do starts). Templates are out of project task lists and counts, search, and title lookups. Occurrences carry `repeatTemplateId`.
- Title lookups prefer live, open items. Area, project, and tag filters resolve like writes (case-insensitive, unknown name is an error). Logbook `since` and `until` given as plain dates are days in the connector's time zone.
- `things_get_account_info` no longer returns the history key.

**Login pages**: every interpolated value is HTML-escaped (`esc` in `pages.js`), and HTML responses carry `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'`. `form-action` is left open because the login POST redirects to the OAuth client's redirect URI and browsers apply `form-action` to that redirect.

**Also**: Maildrop reset and clear are marked destructive. README no longer lists `things_trash_todo` or `things_get_repeating`. The CSV tool description and the migration prompt say that projects and headings must exist first.

**Declined**: closing or refusing open children when a project is completed (needs a product decision; the read side now hides them); refusing new to-dos in completed projects (would also refuse imports of finished projects); rebuilding read-modify-write patches after a 409; per-session time zones; ignoring `when` on non-reschedule to-do batches; OAuth storage changes (credential oracle ordering, duplicate credential copy, key derivation). No repeat-rule create or edit tools were added.

**Unverified**: how the Things apps treat the newly refused states; the meaning of `rr.ts` as "days the to-do starts before its deadline" (docs only show `ts: 0`); that Things removes untrashed children when it empties a trashed project; `empty_trash` and Maildrop reset and clear against the live service; the CSP in a real browser OAuth round trip.

**Verification**: `npm test`, 78 tests, mocked fetch only. Deployed 2026-11-09; a live project read returned the new repeating fields.

---

## 2026-11-09 - Write hardening: state-aware validator, safe commit path, fail-closed reads (not deployed)

**What changed**: `validateChangeMap(body, db)` now also checks shapes and state, and `commitChanges` runs it against the synced database on every write (and again after a 409/412 re-sync). It refuses unknown entity names and property keys (only `Task6`, `ChecklistItem3`, `Tag4`, `Area3`), dropped `undefined` values, partial creates, and a 0 in `sr`/`tir`/`dd`/`sp`/`icsd`/`ato` ("no date" is `null`). It checks notes (`ch` is the CRC-32), checklist items (the Things 3.24.2 shape, exactly one live parent), `st` against `sr` (future needs 2, today's with 2 is refused, headings use 1, Inbox has no date or container), `ss` against `sp`, and every reference (`pr`, `agr`, `ar`, `tg`, `ts`, `rt`, `pn`) for existence, type, and trash state. A to-do cannot be in both an area and a project, and a heading must belong to the project. Repeat rules use a port of `ThingsRepeat.problems(in:)`; templates accept only title, notes, tags, trash, and container edits, and occurrences refuse `rr`, `rt`, `tp`. Deleting something that live items still reference is refused, and the delete tools now cascade (checklist items, headings, trashed children, tag and area references).

**Commit path**: the body and its ids are built once and resent unchanged. 409/412 retry up to twice after re-reading the head. A 5xx or dropped connection is checked against the history before anything is resent: if it landed it is reported as done, if not it is resent once, if the history is unreadable the error says the outcome is unknown. 4xx says nothing was written. Batch tools are one atomic commit and return per-item results; a bad id names every bad id and writes nothing. `import_json` works on a copy of the cache, so a refused commit no longer leaves ghost entities in it, and it refuses entry types it cannot write instead of skipping them.

**Read path**: history paging advances by items received; an empty or malformed page, a missing or non-integer head, or a head of 0 after a synced history fails closed. A pull is applied to a copy and swapped in only when complete.

**Behavior changes**: `add_todo` with a project, heading, or area defaults to Anytime (it used to default to the Inbox, a state Things does not use for filed to-dos); moving an Inbox to-do into a container takes it out of the Inbox; converting a to-do to a project clears its project and heading. A reminder at exactly 00:00 is refused (`ato` 0 reads as "no date"). CI: `.github/workflows/test.yml` runs `npm test` on path-scoped pushes and PRs.

**Verification**: `npm test` (mocked fetch only, no live calls). Not deployed, not committed.

---

## 2026-11-09 - Things 3.24 crashed on ids the connector minted; ids and dates now validated

**What happened**: Things 3.24.2 beta on the Mac crashed on launch in `LegacySCHistoryPerformSync` (precondition in `decodeBase58String`, entity `Task7`). Things ids are a 16-byte UUID in Bitcoin-style base58 (leading zero bytes become leading "1"s), and the app decodes each into a 16-byte buffer. `generateUUID()` produced 22 random base58 characters, which need 17 bytes about 45% of the time: values above 2^128, or a leading "1". All 2,077 native keys in the history decode to exactly 16 bytes; 689 connector-era keys did not. Earlier oversized ids were test items created and deleted before the Mac pulled them, so they collapsed away. Today's BCBS import left 135 live items with bad ids, starting with the "BCBS VT" area at history index 1154. The Mac's cursor was 1153.

**Repair**: Two corrective commits (indexes 1355 and 1356) re-created each bad entity under a valid id with its full collapsed properties, repointed 85 children, and deleted the old keys. Indexes 1355 and 1356 covered 128 items with values above 2^128 and 7 items with a leading "1". The Mac pulled the create/delete pairs in one session, launched, and synced to 1356 with 839 tasks matching the cloud. Pre-repair history is saved in the session scratchpad.

**What changed**: `generateUUID()` encodes 16 random bytes canonically. `isThingsId()` and `validateChangeMap()` run inside `commitChanges`, which every write goes through. They refuse any entity id or `pr`/`agr`/`ar`/`tg`/`ts`/`rt`/`dl`/`pn` reference that does not decode to exactly 16 bytes. They also refuse non-numeric or millisecond timestamps (`cd`, `md`, `sp`, `lai`) and calendar dates (`sr`, `tir`, `dd`) that are not at midnight UTC. `parseIsoDate` rejects millisecond values. `import_json` refuses an `id` on a create, which used to fork items when a caller forgot `"operation": "update"`. Test fixtures used fake ids like `PROJ_1`; they now use real-format ids. Server version is 1.2.0.

**Verification**: `npm test` passes 21 tests, including regressions built from the real bad ids. Deployed as Worker version `ee98b5b0-355b-42be-972a-688be48bad92`. Live checks: an `import_json` create with an id was refused with nothing written; `add_todo` minted `8irbC9h8z4DRLmykur2NNS`, which decodes to 16 bytes and was then purged; Things on the Mac stayed running.

---

## 2026-11-09 - Match Things JSON format: dates, updates, and bulk support

**What changed**:
- `things_import_json` now honors every attribute from Cultured Code's Things JSON format: `completed`, `canceled`, `completion-date`, `creation-date`, `when`, `area-id`, `list-id`, and `heading`.
- Container resolution for `list-id`/`list` dynamically detects whether the target is a project or an area (`resolveListRef`), and when a container is specified without an explicit `when`, `when` defaults to `"anytime"` so items land in their intended container rather than defaulting to the Inbox.
- Added full support for `"operation": "update"` with `"id"` in `things_import_json` for both to-dos and projects. Missing IDs throw an explicit error rather than creating a phantom item.
- Per-item `created` or `updated` status is now tracked and returned in `things_import_json` results.
- `things_update_todo` and `things_update_project` now accept `completion_date` and `creation_date` in ISO 8601 format, following Things' rules (completion date only applies to completed/canceled items, and future dates are ignored).
- `things_batch_update_todos` extended to support date operations (`completion_date`, `creation_date`, `deadline`, and operation `"set_dates"`).
- Extended `formatTask`, `getProjects`, and `getProject` to expose `creationDate` and `completionDate` in ISO 8601 strings.
- Added comprehensive unit tests in `test/client.test.js` covering to-do creation with completion date, updating notes and both dates on an existing completed to-do, rejecting updates for non-existent IDs, project completion dates, and container-targeted imports. All 12 tests pass.

## 2026-11-09 - Icons trimmed to fill their canvas

The icons were the 1024px Things tile (824px of artwork inside 100px of transparent margin) scaled down whole, so the tile covered 80% of every canvas: a 3px empty border on the 32px favicon and transparent corners on the 180px apple-touch icon, which iOS fills black. Regenerated the favicons (16/32/48/96), `favicon.ico` (48/32/16), `icon-192/256/512` from the trimmed tile, and made `apple-touch-icon.png` an opaque full-bleed square (checked fully opaque). `icon-1024.png` is the unchanged source art. `things3mcp.org` is now a verified Search Console Domain property (DNS TXT via the Cloudflare authorization; leave it in place). Its sitemap was submitted (2 pages, success) and indexing of the home page was requested.

## 2026-11-09 - Same Search Console hardening as the YNAB connector

Googlebot-UA checks on `things3mcp.org` returned 200 for `/`, icons, `/robots.txt`, `/sitemap.xml` and `/privacy`; `/mcp` and `/sse` return 401 by design. Two gaps found and fixed: plain `http://things3mcp.org/` answered 200 (a duplicate copy of the site) and now returns a 308 to the same path on HTTPS, and `robots.txt` and `sitemap.xml` were served with a one-year `immutable` cache header and now cache for an hour. `robots.txt` also disallows `/mcp`, `/sse`, `/authorize`, `/token`, `/register` and `/callback`. Deployed as Worker version `e53af27e-6f50-42e4-95ce-0b00dfe48a5f`; protected routes still 401 and OAuth metadata is unchanged.

## 2026-11-07 - Writes fixed, sync bug fixed, skill added

**What changed**: Writes now commit in one `POST commit` request using the real wire format (versioned entities `Task6`, `Area3`, `Tag4`, `ChecklistItem3`, short keys), replacing the nonexistent `/stage` flow that returned 404. The decoder reads the same format. Added a 15-second cached, incremental sync with 429 retry, tag and reference resolution by ID or title, and a `USER_TIMEZONE` setting (America/New_York) for Today. Encryption keys moved from `wrangler.jsonc` vars to rotated Worker secrets. A second bug surfaced during live testing: Things Cloud returns history in capped pages (about 1,039 items) and `current-item-index` is the server head, so the old loop skipped everything after the first page for any new session. The loop now advances by items received (regression test added). Project progress counts canceled to-dos as done, markdown export strikes them through, and the server instructions point clients at the `things-3` skill.

**Verification**: `npm test` passes 6 tests. Every tool except `empty_trash` and Maildrop reset/clear was run through the deployed connector against the live account, with all test items and two leftovers from earlier local tests deleted; counts returned to 496 to-dos, 23 projects, 7 tags, 3 trashed. Deployed versions: `b3cdef27` (display fixes), `3ffad47f` (server instructions, current). Commits through `e5e911e`.

**Decisions made**: Keep `wrangler.jsonc` vars to non-secret values only. Treat the connector as a normal route in the skill.

**Left off at**: Nothing in flight.

**Open questions**: Issue #1 (untested `empty_trash`, Maildrop reset and clear, Mac app visibility) and issue #2 (Upcoming includes today, stale `update_area` schema). No README yet.

---
