# 0028 — MCP SDK for the daemon's relay

- Status: accepted
- Date: 2026-09-26

## Context

Claude Code starts one MCP server per run, `orchestrator-daemon mcp --run <id>`, over stdio (06, section 1). It is a thin relay: it lists the Orchestrator's tools with their descriptions and input schemas, and passes each call to the daemon, which adds the run token and forwards it to the server. All validation happens on the server, which answers refusals with the codes of 06, section 3. The fake `claude` of the tests has its own minimal MCP client (ADR 0027), which must be tested against the real relay so the two cannot drift (owner's decision, lot 2 step F).

The official TypeScript SDK exists in two lines: `@modelcontextprotocol/sdk` 1.30.1, the older single package with its HTTP server dependencies (Express, Hono, CORS, JOSE and more), and `@modelcontextprotocol/server` 2.1.0, the split v2 package (released 2026-09-23, the `latest` tag, not a pre-release), whose README calls v2 "the stable release line". It depends only on `zod` and `@modelcontextprotocol/core`. The owner asked for v2 provided it is a stable release, and v1 otherwise (working rule 2).

## Decision

- The relay uses `@modelcontextprotocol/server` 2.1.0, pinned exactly, as a `devDependency` of the daemon since it is bundled into the daemon's single file (ADR 0026); its license and that of `@modelcontextprotocol/core` are in the package's `THIRD-PARTY-LICENSES.txt`.
- It uses the SDK's **low-level `Server`** with `StdioServerTransport`, and registers `tools/list` and `tools/call` itself:
  - `tools/list` returns the tools of `packages/protocol` (`MCP_TOOLS`): wire name, description, and input schema converted to JSON Schema with Zod's `toJSONSchema`;
  - `tools/call` passes the arguments as they are to the daemon, through the run's socket; the relay never checks them and never holds the run token;
  - a result is JSON text; a refusal is a result marked `isError` whose text is the JSON `{ code, message, details }` of 06, section 3 (owner's decision, lot 2 step G).
- The SDK marks `Server` as deprecated for ordinary use in favour of the high-level `McpServer`, and keeps it "for advanced use cases". The two uses carry an ESLint exception naming this ADR.
- The fake `claude`'s client is tested against this relay in the runner tests, including `tools/list`.

## Alternatives considered

- **`@modelcontextprotocol/sdk` 1.x**: stable too, but the older line, and it brings the HTTP server libraries the relay never uses. Working rule 2 asks for the current stable version.
- **The high-level `McpServer` with `registerTool`**: it validates the arguments against the Zod schema before the handler runs, and answers a bad input with its own error. The server would then not see the call, and the agent would get an SDK message instead of `VALIDATION_FAILED` with details, against "all validation happens on the server" (06, section 1).
- **A hand-written JSON-RPC server**, like the fake's client: small, but the relay talks to the real Claude Code, and protocol version negotiation, notifications and cancellation are what the SDK exists for. The fake's own client stays hand-written on purpose, so the two implementations check each other.

## Consequences

- One small dependency tree (`zod`, which the daemon already uses, and `core`).
- The relay depends on the low-level `Server`. If a later major version removes it, the relay moves to whatever the SDK then offers for unchecked arguments, or to `McpServer` with schemas that accept any object; the runner tests show the difference at once.
- The SDK aborts calls still running when Claude Code closes the relay's stdin; the daemon's own timeout (the "MCP call timeout" setting) always answers earlier than Claude Code's (the "Claude Code MCP tool timeout" setting, written into `mcp.json`).
