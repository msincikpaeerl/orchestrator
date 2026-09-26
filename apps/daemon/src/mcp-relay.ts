import { Server, type CallToolResult, type Tool } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { MCP_TOOLS, type McpToolName } from '@orchestrator/protocol';
import { z } from 'zod';
import type { DaemonPaths } from './paths.js';
import { callThroughRun, type McpAnswer } from './run-socket.js';
import { DAEMON_VERSION } from './version.js';

// `orchestrator-daemon mcp --run <id>` (06, section 1): the MCP server Claude Code starts for a
// run, over stdio. A thin relay built on the MCP SDK's low-level server (ADR 0028): it lists the
// tools of `packages/protocol` and passes each call, arguments as given, to the daemon through
// the run's socket. All validation happens on the server; the relay never holds the run token.

/** The tools as Claude Code lists them: wire name, description, input as JSON Schema. */
export function relayTools(): Tool[] {
  return (Object.keys(MCP_TOOLS) as McpToolName[]).map((name) => ({
    name,
    description: MCP_TOOLS[name].description,
    inputSchema: z.toJSONSchema(MCP_TOOLS[name].input, { io: 'input' }) as Tool['inputSchema'],
  }));
}

/** A result for Claude Code: the output as JSON text, or the refusal marked as an error. */
export function toolResult(answer: McpAnswer): CallToolResult {
  return answer.ok
    ? { content: [{ type: 'text', text: JSON.stringify(answer.output) }] }
    : { content: [{ type: 'text', text: JSON.stringify(answer.error) }], isError: true };
}

/** Builds the relay's server; `call` reaches the daemon. */
export function createRelay(
  call: (tool: string, args: Record<string, unknown>) => Promise<McpAnswer>,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- the low-level server, which the SDK keeps for this case: arguments pass through unchecked, since the server validates them (ADR 0028).
): Server {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- as above.
  const server = new Server(
    { name: 'orchestrator', version: DAEMON_VERSION },
    { capabilities: { tools: {} } },
  );
  const tools = relayTools();
  server.setRequestHandler('tools/list', () => ({ tools }));
  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: args } = request.params;
    return toolResult(await call(name, args ?? {}));
  });
  return server;
}

/** Runs the relay on stdin and stdout until Claude Code closes it. */
export async function runRelay(paths: DaemonPaths, runId: string): Promise<number> {
  const server = createRelay((tool, args) =>
    callThroughRun(paths, runId, { type: 'mcp', tool, arguments: args }),
  );
  const closed = new Promise<void>((resolve) => {
    server.onclose = resolve;
  });
  await server.connect(new StdioServerTransport());
  await closed;
  return 0;
}
