import { chmod, rm } from 'node:fs/promises';
import { createConnection, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { HookAnswer, RunSocketRequest, type HookEvent } from '@orchestrator/protocol';
import { safeJson } from './config.js';
import type { DaemonPaths } from './paths.js';

// A run's socket, `runs/<run-id>/daemon.sock` (05, sections 4.2 and 4.5): the hook and status
// line commands Claude Code runs send it their input and print its answer. An agent runs under
// the same user and could write to it too; the barrier is the server, where the run's token only
// allows actions on that run's own ticket (05, section 2).

export function runFolder(paths: DaemonPaths, runId: string): string {
  return join(paths.home, 'runs', runId);
}

export function runSocketPath(paths: DaemonPaths, runId: string): string {
  return join(runFolder(paths, runId), 'daemon.sock');
}

/** What the command prints when the daemon does not answer (05, section 4.5). */
export function unreachableAnswer(event: HookEvent | 'status_line'): HookAnswer {
  if (event !== 'PreToolUse') return { stdout: '', exitCode: 0 };
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Orchestrator daemon unavailable',
      },
    }),
    exitCode: 0,
  };
}

/** Listens on `path` (a stale file is replaced); `handle` answers each request. */
export async function serveRunSocket(
  path: string,
  handle: (request: RunSocketRequest) => Promise<HookAnswer>,
): Promise<Server> {
  await rm(path, { force: true });
  const server = createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      socket.pause();
      const request = RunSocketRequest.safeParse(safeJson(buffer.slice(0, end)));
      const answer = request.success
        ? handle(request.data)
        : Promise.resolve<HookAnswer>({ stdout: '', exitCode: 0 });
      void answer.then(
        (result) => socket.end(`${JSON.stringify(result)}\n`),
        () => socket.end(`${JSON.stringify({ stdout: '', exitCode: 0 })}\n`),
      );
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
  request: RunSocketRequest,
): Promise<HookAnswer> {
  const fallback = unreachableAnswer(request.type === 'hook' ? request.event : 'status_line');
  return new Promise((resolve) => {
    const socket = createConnection(runSocketPath(paths, runId));
    let received = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: string) => (received += chunk));
    socket.on('end', () => {
      const answer = HookAnswer.safeParse(safeJson(received.trim()));
      resolve(answer.success ? answer.data : fallback);
    });
    socket.on('error', () => {
      resolve(fallback);
    });
  });
}
