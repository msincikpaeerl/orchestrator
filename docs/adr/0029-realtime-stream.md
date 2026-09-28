# 0029 — Realtime stream: Server-Sent Events fed by PostgreSQL notifications

- Status: accepted
- Date: 2026-09-29

## Context

Screens update live (02, section 1): one Server-Sent Events stream per logged-in browser carries "changed" messages (kind of entity, id, project) and notices of new run log entries; the screen reads again what changed, and fetches a run's log entries after the last one it holds (owner's decisions, lot 2 steps A and L). The server is a single process (09, section 4).

The stream must never announce a change that was not saved: most changes are written in transactions that can still fail after the code made the change (a refusal found late, a lost connection), and a screen reading the data too early would show the old state and never read it again. Every state change already writes an event in its own transaction (01, section 3.10), and run log entries are written in the report's transaction.

## Decision

- **Transport**: Server-Sent Events on `GET /api/stream`, written directly on Fastify's response (`reply.hijack()`), with no library: the format is a few lines of text (`retry`, `data`, comment lines), and the browser's `EventSource` reconnects by itself. The stream sends a keep-alive comment every 20 seconds and a 3-second reconnection delay, code constants (04, section 8). It checks its session at each keep-alive and on each session change, and ends when the session is gone (logout, expiry, revocation); the browser is then refused and shows the login page.
- **Source of the messages**: PostgreSQL `NOTIFY`. `recordEvent` sends `pg_notify` in the transaction that writes the event, and the run log storage does the same with the last entry number. PostgreSQL delivers a notification only when its transaction commits, and never when it is rolled back, so only saved changes reach the stream, without any code having to run "after commit". The payload is built in SQL (the project's key read in the same query) and stays far below PostgreSQL's 8,000-byte limit, since it holds no text of the change.
- **Listener**: one connection of the pool holds `LISTEN` and passes each message to the open streams. When that connection is lost, it is replaced after the same 3-second delay; notifications sent meanwhile are lost, so the streams then send `resync` and the screens read everything again, as after a reconnection of the stream.
- **Browser**: one `EventSource` while a logged-in screen is shown. A "changed" message invalidates the TanStack Query data of that kind of entity; a run log notice wakes the log of that run, which fetches the entries after the last one it holds; an opening after a reconnection, and `resync`, invalidate everything.

## Alternatives considered

- **Publishing from the application after each commit**: every transaction writing an event would need a hook after its commit, and a forgotten one would be a screen that silently stops updating. `NOTIFY` covers every event write in one place, including the ones inside larger transactions.
- **A database trigger on `events`**: same guarantee, but the notification would live in a migration, away from the code writing events; `recordEvent` is already the one place every event goes through.
- **WebSocket for the browser**: two-way, which the screens do not need (their actions are API calls), and the server already speaks WebSocket only with daemons. SSE reconnects by itself and passes through proxies as a plain HTTP response.
- **Log lines in the stream** (the wording of 02 and 09 before step L): a stream per browser would have to know which runs each screen shows, and lines missed during a reconnection would need fetching anyway. The notice plus the existing paged log endpoint gives a single path with no gap (owner's decision, lot 2 step L).
- **A library** (`fastify-sse-v2`, `@fastify/websocket` for the browser): not needed for a one-way text stream.

## Consequences

- One pool connection is held for `LISTEN` while the server runs.
- A change that writes no event (a machine's heartbeat time, for example) reaches the screens only on focus, after an action or after a reconnection; every state change writes an event (01, section 3.10), so screens miss no state.
- Tests prove that a rolled-back event sends nothing, that the stream ends at logout and at the keep-alive after the session is gone, and that a lost listener is replaced with a `resync` (`apps/server/test/stream.test.ts`).
