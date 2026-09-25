# 0025 — WebSocket library for the daemon connection

- Status: accepted
- Date: 2026-09-25

## Context

The daemon keeps one WebSocket to the server (09, section 3; 05, section 3.2). The server runs on Fastify 5 (ADR 0009) and must authenticate the connection before it opens (an unknown machine token gets HTTP 401), close connections with its own close codes, and share Fastify's logger, error handling and shutdown. The daemon (lot 2 step E) and the tests need a client that sends the token in an `Authorization` header.

## Decision

- Server: `@fastify/websocket` 11.3.1, Fastify's official plugin. The `/daemon` route is an ordinary Fastify route with `websocket: true`; its `preValidation` hook checks the machine token and refuses with HTTP 401 before the upgrade. The plugin's `preClose` closes every daemon connection with the `shutdown` close code when the server stops.
- Client (daemon and tests): `ws` 8.21.3, the library `@fastify/websocket` itself is built on, with `@types/ws` 8.18.1 for its types. The tests' scripted daemon (`apps/server/test/daemon-client.ts`) uses it now; the daemon adds it as its own dependency in step E.
- Messages are JSON text frames validated with the Zod schemas of `packages/protocol` (`DaemonMessage`, `ServerMessage`); frames are limited to 1 MiB.

## Alternatives considered

- **`ws` directly on the Node.js HTTP server**: works, but authentication, logging and shutdown would bypass Fastify and duplicate what the plugin gives.
- **Socket.IO**: adds its own protocol, rooms and reconnection on top of WebSocket. The daemon already has its reconnection rules (05, section 3.2) and message format (05, section 3.3); the extra protocol only adds weight and a second version to keep compatible.
- **Node.js's built-in `WebSocket` client** (from Node.js 22): it follows the browser API, whose standard has no request headers; the token must not travel in the URL, where proxies and logs may record it. `ws` sets headers in its documented API and is the implementation the server plugin already uses.

## Consequences

- One library family on both ends: the server's plugin and the clients speak the same `ws` implementation.
- The daemon depends on `ws` rather than the built-in client.
- Upgrading `@fastify/websocket` follows Fastify's major versions.
