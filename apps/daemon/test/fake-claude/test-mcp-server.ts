import { createInterface } from 'node:readline';

// A minimal MCP server over stdio for the fake `claude`'s own tests: `echo` returns its
// arguments. The runner tests use the daemon's SDK-based relay instead (ADR 0028).

const send = (message: unknown) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line) as { id?: number; method: string; params?: unknown };
  if (request.id === undefined) return;
  switch (request.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'test', version: '1' },
        },
      });
      return;
    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] },
      });
      return;
    case 'tools/call': {
      const { name, arguments: args } = request.params as { name: string; arguments: unknown };
      send({
        jsonrpc: '2.0',
        id: request.id,
        result:
          name === 'echo'
            ? { content: [{ type: 'text', text: JSON.stringify(args) }] }
            : { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true },
      });
      return;
    }
    default:
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unknown method' } });
  }
});
