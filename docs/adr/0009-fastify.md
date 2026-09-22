# 0009 — Fastify for the server

- Status: accepted
- Date: 2026-09-23

## Context

09, section 3 chooses Fastify for the server: API, SSE, daemon WebSocket gateway, MCP backend and static UI hosting, in one process (09, section 4).

## Decision

- `apps/server` uses Fastify 5.
- `buildApp` creates the application without listening, so tests call routes with `inject`; `startServer` applies migrations then listens on `0.0.0.0` and `PORT`.
- Fastify's logger is the shared Pino logger (ADR 0013).
- Request and response types come from Zod schemas in `packages/protocol` (ADR 0012). How Fastify validates request bodies with them is decided with the first endpoint that takes input (lot 0, step C).

## Alternatives considered

- Express: no built-in schema validation or typed routes, slower, older plugin model.
- Hono: good typing, but a smaller ecosystem for WebSocket, static files and cookies on Node.js.
- NestJS: heavy framework and conventions for a single-user, single-process server.

## Consequences

- WebSocket, static files and cookies come from official `@fastify/*` plugins when needed.
- `/health` is polled by Docker; its request logs are at `warn` level so they do not flood the logs.
