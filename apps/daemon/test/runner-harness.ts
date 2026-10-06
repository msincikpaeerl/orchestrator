import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DaemonMessage,
  McpCall,
  McpResult,
  RunLogEvent,
  RunStart,
  RunState,
} from '@orchestrator/protocol';
import type { Logger } from 'pino';
import { afterEach, beforeEach, expect } from 'vitest';
import type { CredentialSource } from '../src/credentials.js';
import { findExecutable } from '../src/exec.js';
import { Git } from '../src/git.js';
import { TMUX_SOCKET_NAME } from '../src/paths.js';
import { RunManager } from '../src/runs.js';
import { ProcessScopes } from '../src/scopes.js';
import { tmuxScopeName, unitPrefix, type UserSystemd } from '../src/systemd.js';
import { Tmux } from '../src/tmux.js';
import { TrustRegistry } from '../src/trust.js';
import { Workspaces } from '../src/workspace.js';
import { installFakeClaude, type FakeClaude } from './fake-claude/install.js';
import { createRemote } from './remote.js';
import { runStartPayload } from './run-start.js';
import {
  DAEMON_COMMAND,
  captureLogger,
  createTestHome,
  linkSystemTool,
  stopHomeProcesses,
  waitFor,
  type TestHome,
} from './testing.js';

// The runner's test harness (ADR 0027): a throw-away home with the real Git and tmux, the fake
// `claude`, a local remote, and run managers whose server is a recorder that acknowledges every
// report and answers tool calls as a test says. Names are live bindings, reset before each test.

export const TIMEOUT = 60_000;

export let home: TestHome;
export let fake: FakeClaude;
export let tmux: Tmux;
export let cloneUrl: string;
export let managers: RunManager[];
export let sent: DaemonMessage[];
/** The tool calls the daemon sent to the server, and how the scripted server answers them. */
export let toolCalls: McpCall['payload'][];
export let serverTool: (call: McpCall['payload']) => McpResult['payload'];

/** Registers the set-up and clean-up of each test of the calling file. */
export function useRunnerHarness(): void {
  beforeEach(async () => {
    home = await createTestHome();
    await linkSystemTool(home.bin, 'git');
    await linkSystemTool(home.bin, 'tmux');
    fake = await installFakeClaude(home.bin, join(home.root, 'fake'));
    // The test's own tmux server, apart from the owner's and other tests' (ADR 0027).
    const tmuxDir = join(home.root, 'tmux');
    await mkdir(tmuxDir, { mode: 0o700 });
    home.env.TMUX_TMPDIR = tmuxDir;
    tmux = new Tmux(join(home.bin, 'tmux'), home.env);
    const remote = await createRemote(join(home.root, 'remotes'), 'owner', 'notes', home.env);
    cloneUrl = `file://${remote}`;
    managers = [];
    sent = [];
    toolCalls = [];
    serverTool = () => ({ ok: true, output: {} });
  });
  afterEach(async () => {
    for (const manager of managers) await manager.shutdown();
    spawnSync(join(home.bin, 'tmux'), ['-L', TMUX_SOCKET_NAME, 'kill-server'], { env: home.env });
    await stopHomeProcesses(home);
    await home.remove();
  });
}

/**
 * Adds the system folders to the sessions' `PATH`, for scenarios running `sleep`, `nohup` or
 * `setsid`. tmux gives a new session the `PATH` of its client, so the client is made again.
 */
export function addSystemPath(): void {
  home.env.PATH = `${home.env.PATH ?? ''}:/usr/bin:/bin`;
  tmux = new Tmux(join(home.bin, 'tmux'), home.env);
}

/**
 * A daemon's run manager; `secondMs` shortens the run limits. With `systemd` (the systemd tests
 * only), the tmux server and each run get their scopes, named with the test home's prefix. A
 * test may give its own `tmux` client, and a `log` to read.
 */
export function daemon(
  options: {
    secondMs?: number;
    acknowledge?: boolean;
    systemd?: UserSystemd;
    scopes?: ProcessScopes;
    tmux?: Tmux;
    log?: Logger;
    /** How the scripted server answers credential requests: refused by default. */
    credentials?: CredentialSource;
  } = {},
): RunManager {
  const log = options.log ?? captureLogger().log;
  const trust = new TrustRegistry(join(home.paths.claudeConfig, '.claude.json'));
  const prefix = unitPrefix(home.paths);
  const manager = new RunManager({
    paths: home.paths,
    log,
    tmux: options.systemd
      ? new Tmux(join(home.bin, 'tmux'), home.env, {
          systemd: options.systemd,
          unit: tmuxScopeName(prefix),
          marker: join(home.paths.home, 'tmux-scope-started'),
          shell: '/bin/sh',
        })
      : (options.tmux ?? tmux),
    trust,
    workspaces: new Workspaces({
      paths: home.paths,
      git: new Git(join(home.bin, 'git'), home.env),
      trust,
      credentials:
        options.credentials ??
        (() => Promise.resolve({ ok: false, message: 'no credential in these tests' })),
      selfCommand: DAEMON_COMMAND,
      log,
    }),
    callServer: (call) => {
      toolCalls.push(call);
      return Promise.resolve(serverTool(call));
    },
    selfCommand: DAEMON_COMMAND,
    toolPath: home.env.PATH ?? '',
    envCommand: findExecutable('env', process.env.PATH) ?? '/usr/bin/env',
    secondMs: options.secondMs ?? 1000,
    systemd: options.systemd ?? null,
    unitPrefix: prefix,
    scopes: options.scopes ?? new ProcessScopes('terminal', null),
  });
  manager.outbox.connect((message) => {
    sent.push(message);
    if (options.acknowledge ?? true) {
      setImmediate(() => manager.outbox.ack(message.id, true, null));
    }
    return true;
  });
  managers.push(manager);
  return manager;
}

export async function start(
  manager: RunManager,
  changes: Parameters<typeof runStartPayload>[1] = {},
): Promise<RunStart['payload']> {
  const payload = runStartPayload(cloneUrl, changes);
  expect(await manager.handle({ type: 'run.start', id: randomUUID(), payload })).toEqual({
    ok: true,
  });
  return payload;
}

export function states(runId: string): RunState['payload'][] {
  return sent
    .filter((message): message is RunState => message.type === 'run.state')
    .map((message) => message.payload)
    .filter((payload) => payload.runId === runId);
}

export function logEvents(runId: string): RunLogEvent[] {
  return sent.flatMap((message) =>
    message.type === 'run.events' && message.payload.runId === runId ? message.payload.events : [],
  );
}

export async function ended(runId: string, timeoutMs = 30_000) {
  await waitFor(
    () => states(runId).some((state) => state.state === 'ended'),
    timeoutMs,
    'the end of the run',
  );
  const last = states(runId).at(-1);
  if (last?.state !== 'ended') throw new Error('the last state is not ended');
  return last;
}

export async function messagesReceived(): Promise<string[]> {
  return (await fake.log()).flatMap((entry) => (entry.event === 'message' ? [entry.text] : []));
}

/** Answers the scripted server's tool calls with `answer`. */
export function answerTools(answer: typeof serverTool): void {
  serverTool = answer;
}
