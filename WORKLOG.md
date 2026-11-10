# Things MCP connector worklog

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
