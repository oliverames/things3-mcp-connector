# Things MCP connector worklog

## 2026-11-09 - Same Search Console hardening as the YNAB connector

Googlebot-UA checks on `things3mcp.org` returned 200 for `/`, icons, `/robots.txt`, `/sitemap.xml` and `/privacy`; `/mcp` and `/sse` return 401 by design. Two gaps found and fixed: plain `http://things3mcp.org/` answered 200 (a duplicate copy of the site) and now returns a 308 to the same path on HTTPS, and `robots.txt` and `sitemap.xml` were served with a one-year `immutable` cache header and now cache for an hour. `robots.txt` also disallows `/mcp`, `/sse`, `/authorize`, `/token`, `/register` and `/callback`. Deployed as Worker version `e53af27e-6f50-42e4-95ce-0b00dfe48a5f`; protected routes still 401 and OAuth metadata is unchanged.

## 2026-11-07 - Writes fixed, sync bug fixed, skill added

**What changed**: Writes now commit in one `POST commit` request using the real wire format (versioned entities `Task6`, `Area3`, `Tag4`, `ChecklistItem3`, short keys), replacing the nonexistent `/stage` flow that returned 404. The decoder reads the same format. Added a 15-second cached, incremental sync with 429 retry, tag and reference resolution by ID or title, and a `USER_TIMEZONE` setting (America/New_York) for Today. Encryption keys moved from `wrangler.jsonc` vars to rotated Worker secrets. A second bug surfaced during live testing: Things Cloud returns history in capped pages (about 1,039 items) and `current-item-index` is the server head, so the old loop skipped everything after the first page for any new session. The loop now advances by items received (regression test added). Project progress counts canceled to-dos as done, markdown export strikes them through, and the server instructions point clients at the `things-3` skill.

**Verification**: `npm test` passes 6 tests. Every tool except `empty_trash` and Maildrop reset/clear was run through the deployed connector against the live account, with all test items and two leftovers from earlier local tests deleted; counts returned to 496 to-dos, 23 projects, 7 tags, 3 trashed. Deployed versions: `b3cdef27` (display fixes), `3ffad47f` (server instructions, current). Commits through `e5e911e`.

**Decisions made**: Keep `wrangler.jsonc` vars to non-secret values only. Treat the connector as a normal route in the skill.

**Left off at**: Nothing in flight.

**Open questions**: Issue #1 (untested `empty_trash`, Maildrop reset and clear, Mac app visibility) and issue #2 (Upcoming includes today, stale `update_area` schema). No README yet.

---
