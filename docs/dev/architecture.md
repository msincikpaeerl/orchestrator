# Architecture

The full description is in [09 — Architecture and Deployment](../specs/09-architecture-and-deployment.md). This page tracks what exists in the code today.

## Components

| Folder | Package | Role | State |
|---|---|---|---|
| `apps/server` | `@orchestrator/server` | Fastify server: API, realtime, daemon gateway, MCP backend, scheduler, GitHub integration, serves the UI. | placeholder |
| `apps/web` | `@orchestrator/web` | React UI, built into static files served by the server. | placeholder |
| `apps/daemon` | `@orchestrator/daemon` | Runs on each machine: tmux and Claude Code sessions, hooks, MCP relay. | placeholder |
| `packages/protocol` | `@orchestrator/protocol` | Zod schemas shared by all apps. Holds `PROTOCOL_VERSION`. | placeholder |
| `packages/db` | `@orchestrator/db` | Drizzle schema and SQL migrations. | placeholder |

## Dependencies between packages

```
apps/server  ──► packages/protocol, packages/db
apps/daemon  ──► packages/protocol
apps/web     ──► packages/protocol
```

Only `apps/server → packages/protocol` exists so far; the others are added with the code that needs them.

## Decisions

Technical choices are recorded in [`docs/adr/`](../adr/).
