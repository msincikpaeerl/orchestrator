import { chmod, rm } from 'node:fs/promises';
import { createConnection, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import {
  HookAnswer,
  McpResult,
  RunSocketRequest,
  RunToolsAnswer,
  type HookEvent,
  type McpToolName,
} from '@orchestrator/protocol';
import { safeJson } from './config.js';
import type { DaemonPaths } from './paths.js';

// A run's socket, `runs/<run-id>/daemon.sock` (05, sections 4.2 and 4.5): the hook and status
// line commands Claude Code runs send it their input and print its answer, and the run's MCP
// relay sends it the agent's tool calls (06, section 1). An agent runs under
// the same user and could write to it too; the barrier is the server, where the run's token only
// allows actions on that run's own ticket (05, section 2).

export function runFolder(paths: DaemonPaths, runId: string): string {
  return join(paths.home, 'runs', runId);
}

export function runSocketPath(paths: DaemonPaths, runId: string): string {
  return join(runFolder(paths, runId), 'daemon.sock');
}

/** A `PreToolUse` answer refusing the call, with the reason the agent reads (05, section 4.6). */
export function denyAnswer(reason: string): HookAnswer {
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
    exitCode: 0,
  };
}

/** What the command prints when the daemon does not answer (05, section 4.5). */
export function unreachableAnswer(event: HookEvent | 'status_line'): HookAnswer {
  if (event !== 'PreToolUse') return { stdout: '', exitCode: 0 };
  return denyAnswer('Orchestrator daemon unavailable');
}

/** The answer to a request of the run's MCP relay. */
export type McpAnswer = McpResult['payload'];

/** What the socket answers: a hook's output, or a tool's result for the relay. */
export type RunSocketAnswer = HookAnswer | McpAnswer | RunToolsAnswer;

/**
 * A connection to a run's socket, from its opening until it closes: a hook or status line
 * command, or the MCP relay. Kept so the daemon can log those still open when it kills the
 * session (05, section 4.11; lot 3 decision Q32).
 */
export interface RunConnection {
  /** `Date.now()` at the opening. */
  since: number;
  /** "hook Stop", "status_line", "mcp ticket_get", "tools"; null until a whole line is read. */
  request: string | null;
  /** Whether the daemon has sent its answer (the command may still be reading it or exiting). */
  answered: boolean;
}

function describeRequest(request: RunSocketRequest): string {
  switch (request.type) {
    case 'hook':
      return `hook ${request.event}`;
    case 'mcp':
      return `mcp ${request.tool}`;
    default:
      return request.type;
  }
}

/**
 * Listens on `path` (a stale file is replaced); `handle` answers each request. `open` holds the
 * connections not closed yet.
 */
export async function serveRunSocket(
  path: string,
  handle: (request: RunSocketRequest) => Promise<RunSocketAnswer>,
  open: Set<RunConnection> = new Set(),
): Promise<Server> {
  await rm(path, { force: true });
  const server = createServer((socket) => {
    const connection: RunConnection = { since: Date.now(), request: null, answered: false };
    open.add(connection);
    socket.on('close', () => open.delete(connection));
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      socket.pause();
      const request = RunSocketRequest.safeParse(safeJson(buffer.slice(0, end)));
      connection.request = request.success ? describeRequest(request.data) : 'not understood';
      const answer = request.success
        ? handle(request.data)
        : Promise.resolve<RunSocketAnswer>({ stdout: '', exitCode: 0 });
      const send = (result: unknown) => {
        connection.answered = true;
        socket.end(`${JSON.stringify(result)}\n`);
      };
      void answer.then(send, () => {
        send({ stdout: '', exitCode: 0 });
      });
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await chmod(path, 0o600);
  return server;
}

/**
 * `orchestrator-daemon hook <event> --run <id>` and `status-line --run <id>` (internal): sends
 * Claude Code's input to the run's socket and returns what to print and the exit code.
 */
export function forwardToRun(
  paths: DaemonPaths,
  runId: string,
  request: Extract<RunSocketRequest, { type: 'hook' | 'status_line' }>,
): Promise<HookAnswer> {
  const fallback = unreachableAnswer(request.type === 'hook' ? request.event : 'status_line');
  return ask(paths, runId, request, (text) => {
    const answer = HookAnswer.safeParse(safeJson(text));
    return answer.success ? answer.data : fallback;
  });
}

/** The answer of the relay when the daemon cannot be reached (06, section 3). */
export const DAEMON_UNREACHABLE: McpAnswer = {
  ok: false,
  error: {
    code: 'UNAVAILABLE',
    message:
      'The Orchestrator daemon on this machine does not answer. Try again in a few minutes; if it keeps failing, end your turn.',
  },
};

/** The run's MCP relay: sends one tool call to the daemon and returns its result. */
export function callThroughRun(
  paths: DaemonPaths,
  runId: string,
  request: Extract<RunSocketRequest, { type: 'mcp' }>,
): Promise<McpAnswer> {
  return ask(paths, runId, request, (text) => {
    const answer = McpResult.shape.payload.safeParse(safeJson(text));
    return answer.success ? answer.data : DAEMON_UNREACHABLE;
  });
}

/**
 * The run's MCP tools, for the relay's list (06, section 5); null when the daemon cannot be
 * reached or gives no list.
 */
export function toolsOfRun(paths: DaemonPaths, runId: string): Promise<McpToolName[] | null> {
  return ask(paths, runId, { type: 'tools' }, (text) => {
    const answer = RunToolsAnswer.safeParse(safeJson(text));
    return answer.success ? answer.data.tools : null;
  });
}

function ask<Answer>(
  paths: DaemonPaths,
  runId: string,
  request: RunSocketRequest,
  read: (text: string) => Answer,
): Promise<Answer> {
  return new Promise((resolve) => {
    const socket = createConnection(runSocketPath(paths, runId));
    let received = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: string) => (received += chunk));
    socket.on('end', () => {
      resolve(read(received.trim()));
    });
    socket.on('error', () => {
      resolve(read(''));
    });
  });
}
