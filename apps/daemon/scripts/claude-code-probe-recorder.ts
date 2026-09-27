import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

// The recorder of the Claude Code probe (lot 2 plan, step H; `tools/smoke/claude-code-probe.sh`).
// The daemon's settings generation points the hooks, the status line and the MCP server at the
// daemon's own commands, which need a running daemon: the probe gives the same generation this
// file as its command instead, so the settings keep the daemon's shape. Usage, as generated:
//
//   claude-code-probe-recorder.ts --log <folder> hook <event> --run <name>
//   claude-code-probe-recorder.ts --log <folder> status-line --run <name>
//   claude-code-probe-recorder.ts --log <folder> mcp --run <name>
//
// Hooks append their input to `hooks-<name>.jsonl` and decide nothing (Claude Code's own rules
// apply); the status line appends its input to `status-line-<name>.jsonl`; the MCP server writes
// `mcp-started-<name>` when Claude Code starts it and offers one tool, `ping`. No imports from
// the workspace: each hook call stays quick.

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined) throw new Error(`missing ${name}`);
  return value;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => (text += chunk));
    process.stdin.on('end', () => {
      resolve(text);
    });
  });
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { unparsed: text };
  }
}

function record(file: string, entry: Record<string, unknown>): void {
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

/** A minimal MCP server over stdio (newline-delimited JSON-RPC) with one tool. */
function serveMcp(name: string): void {
  const send = (message: Record<string, unknown>) => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };
  createInterface({ input: process.stdin }).on('line', (line) => {
    const request = parsed(line) as {
      id?: number | string;
      method?: string;
      params?: { protocolVersion?: string };
    };
    if (request.id === undefined) return;
    switch (request.method) {
      case 'initialize':
        send({
          id: request.id,
          result: {
            protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: `probe-${name}`, version: '1.0.0' },
          },
        });
        return;
      case 'tools/list':
        send({
          id: request.id,
          result: {
            tools: [
              {
                name: 'ping',
                description: 'Answers pong. Used by an automated check.',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          },
        });
        return;
      case 'tools/call':
        send({
          id: request.id,
          result: { content: [{ type: 'text', text: `pong from ${name}` }] },
        });
        return;
      case 'ping':
        send({ id: request.id, result: {} });
        return;
      default:
        send({ id: request.id, error: { code: -32601, message: 'Method not found' } });
    }
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const log = option(args, '--log');
  const name = option(args, '--run');
  const mode = args[2];
  if (mode === 'hook') {
    const input = parsed(await readStdin());
    record(join(log, `hooks-${name}.jsonl`), { event: args[3] ?? '', input });
  } else if (mode === 'status-line') {
    const input = parsed(await readStdin());
    record(join(log, `status-line-${name}.jsonl`), { input });
    process.stdout.write('probe\n');
  } else if (mode === 'mcp') {
    writeFileSync(join(log, `mcp-started-${name}`), '');
    serveMcp(name);
  } else {
    throw new Error(`unknown mode ${String(mode)}`);
  }
}

await main();
