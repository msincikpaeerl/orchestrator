import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeConfig } from '../src/config.js';
import { TMUX_SOCKET_NAME } from '../src/paths.js';
import { installFakeClaude, type FakeClaude } from './fake-claude/install.js';
import { startGitHttpServer, type GitHttpServer } from './git-http-server.js';
import { createRemote } from './remote.js';
import { runStartPayload } from './run-start.js';
import { ScriptedServer, TOKEN } from './scripted-server.js';
import {
  createTestHome,
  linkSystemTool,
  runDaemon,
  spawnDaemon,
  stopHomeProcesses,
  waitFor,
  type DaemonProcess,
  type TestHome,
} from './testing.js';

// The daemon process with its runs, against a scripted server on the WebSocket (the server's
// side comes in plan step J): run.start, the Git credential asked for the fetch, reports
// acknowledged or resent, and a restart that finds the session again.

const TIMEOUT = 90_000;
let home: TestHome;
let fake: FakeClaude;
let server: ScriptedServer;
let git: GitHttpServer;
let daemons: DaemonProcess[];

beforeEach(async () => {
  home = await createTestHome();
  await linkSystemTool(home.bin, 'git');
  await linkSystemTool(home.bin, 'tmux');
  fake = await installFakeClaude(home.bin, join(home.root, 'fake'));
  const tmuxDir = join(home.root, 'tmux');
  await mkdir(tmuxDir, { mode: 0o700 });
  home.env.TMUX_TMPDIR = tmuxDir;
  home.env.PATH = `${home.env.PATH ?? ''}:/usr/bin:/bin`;
  const remotes = join(home.root, 'remotes');
  await createRemote(remotes, 'owner', 'notes', home.env);
  git = await startGitHttpServer(remotes, { username: 'x-access-token', password: TOKEN });
  server = new ScriptedServer();
  await server.listen();
  await writeConfig(home.paths.config, {
    serverUrl: server.url,
    machineId: randomUUID(),
    machineName: 'Desktop',
    machineToken: `omt_${'d'.repeat(43)}`,
    ca: null,
  });
  daemons = [];
});
afterEach(async () => {
  for (const daemon of daemons) {
    daemon.child.kill('SIGTERM');
    await daemon.exited;
  }
  spawnSync(join(home.bin, 'tmux'), ['-L', TMUX_SOCKET_NAME, 'kill-server'], { env: home.env });
  await stopHomeProcesses(home);
  await server.close();
  await git.close();
  await home.remove();
});

/** Every file of a folder with its size and modification time, to show nothing was written. */
async function snapshot(folder: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    const info = await stat(path);
    files[path] = `${String(info.size)}:${String(info.mtimeMs)}`;
  }
  return files;
}

function startDaemon(): DaemonProcess {
  const daemon = spawnDaemon(['start'], home.env);
  daemons.push(daemon);
  return daemon;
}

describe('daemon runs over the connection', () => {
  it(
    'runs a ticket, asks the server for the Git credential, and finds the session after a restart',
    async () => {
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'sleep', ms: 8000 },
              { do: 'text', text: 'Done.' },
            ],
          },
        ],
      });
      const first = startDaemon();
      await waitFor(() => server.hellos().length === 1, 20_000, 'hello');
      expect(server.hellos()[0]?.payload.runs).toEqual([]);

      const payload = runStartPayload(`${git.url}/owner/notes.git`, {
        limits: { maxNudgesPerRun: 0 },
      });
      // Reports stay unacknowledged until the restart.
      server.acknowledge = false;
      const startId = randomUUID();
      server.send({ type: 'run.start', id: startId, payload });
      await waitFor(
        () =>
          server.received.some(
            (message) => message.type === 'ack' && message.id === startId && message.payload.ok,
          ),
        10_000,
        'the ack of run.start',
      );
      await waitFor(
        () => server.states(payload.runId).some((state) => state.payload.state === 'working'),
        30_000,
        'the working state',
      );
      expect(
        server.received.filter((message) => message.type === 'git.credential_request'),
      ).toMatchObject([{ payload: { runId: payload.runId, command: 'fetch' } }]);
      expect(git.requests.some((request) => request.authenticated)).toBe(true);

      const status = await runDaemon(['status'], home.env);
      expect(status.stdout).toContain(`NOTES-1  run ${payload.runId}  working`);
      // The run's branch, created from the base branch: nothing on it that GitHub lacks yet.
      expect(status.stdout).toMatch(
        new RegExp(
          `owner/notes\\n {4}t/1-add-notes {2}head [0-9a-f]{7} {2}used by run ${payload.runId} \\(NOTES-1\\)\\n {6}nothing that is not on GitHub`,
        ),
      );

      // Stopped while the agent works: the session goes on, the next daemon finds it.
      first.child.kill('SIGTERM');
      expect(await first.exited).toBe(0);
      const before = server.received.length;
      startDaemon();
      await waitFor(() => server.hellos().length === 2, 20_000, 'the second hello');
      expect(server.hellos()[1]?.payload.runs).toEqual([
        { runId: payload.runId, state: 'working', claudeSessionId: expect.any(String) as unknown },
      ]);
      server.acknowledge = true;
      const delivered = server.states(payload.runId).slice(0, 3);
      expect(delivered.map((state) => state.payload.state)).toEqual([
        'preparing',
        'starting',
        'working',
      ]);
      // Reports sent before the restart and never acknowledged come again, in order, same ids.
      await waitFor(
        () =>
          delivered.every((report) =>
            server.received.slice(before).some((message) => message.id === report.id),
          ),
        10_000,
        'the reports sent again',
      );
      const again = server.received.slice(before).map((message) => message.id);
      expect(delivered.map((report) => again.indexOf(report.id))).toEqual(
        [...delivered.map((report) => again.indexOf(report.id))].sort((a, b) => a - b),
      );

      const end = await (async () => {
        await waitFor(
          () => server.states(payload.runId).some((state) => state.payload.state === 'ended'),
          30_000,
          'the end of the run',
        );
        return server.states(payload.runId).at(-1)?.payload;
      })();
      expect(end).toMatchObject({ state: 'ended', reason: 'nudges_exhausted' });
    },
    TIMEOUT,
  );

  it(
    'lists a ticket branch kept after a run with its commits, with a daemon and without, read-only',
    async () => {
      await fake.play({
        turns: [
          {
            steps: [
              {
                do: 'bash',
                command:
                  'echo notes > notes.md && git add notes.md && git commit -q -m "Add notes"',
              },
              { do: 'text', text: 'Committed.' },
            ],
          },
        ],
      });
      const daemon = startDaemon();
      await waitFor(() => server.hellos().length === 1, 20_000, 'hello');
      const payload = runStartPayload(`${git.url}/owner/notes.git`, {
        limits: { maxNudgesPerRun: 0 },
      });
      server.send({ type: 'run.start', id: randomUUID(), payload });
      await waitFor(
        () => server.states(payload.runId).some((state) => state.payload.state === 'ended'),
        60_000,
        'the end of the run',
      );
      const end = server.states(payload.runId).at(-1)?.payload;
      const commit = end?.state === 'ended' ? end.branch?.commitsAhead[0]?.hash : undefined;
      if (commit === undefined) throw new Error('the run reported no commit');
      const listed = new RegExp(
        `owner/notes\\n {4}t/1-add-notes {2}head ${commit.slice(0, 7)}\\n {6}${commit.slice(0, 7)} Add notes`,
      );

      const running = await runDaemon(['status'], home.env);
      expect(running.code).toBe(0);
      expect(running.stdout).toContain('Runs: none');
      expect(running.stdout).toMatch(listed);

      daemon.child.kill('SIGTERM');
      expect(await daemon.exited).toBe(0);
      const bare = join(home.paths.home, 'repos', 'owner', 'notes.git');
      const before = await snapshot(bare);
      const stopped = await runDaemon(['status'], home.env);
      expect(stopped.code).toBe(1);
      expect(stopped.stdout).toContain('No daemon is running.');
      expect(stopped.stdout).toMatch(listed);
      // Read without a fetch, a lock or a write: nothing in the bare clone changed.
      expect(await snapshot(bare)).toEqual(before);
      expect(git.requests.length).toBeGreaterThan(0);
      const fetches = git.requests.length;
      await runDaemon(['status'], home.env);
      expect(git.requests.length).toBe(fetches);
    },
    TIMEOUT,
  );

  it(
    "relays the agent's tool calls to the server, UNAVAILABLE on timeout and on disconnection",
    async () => {
      server.mcpScript = ['answer', 'silent', 'drop', 'answer'];
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'mcp', tool: 'ticket_get', arguments: {} },
              { do: 'mcp', tool: 'ticket_list', arguments: {} },
              { do: 'mcp', tool: 'agent_list', arguments: {} },
              // The daemon connects again (backoff of 1 second) before the next call.
              { do: 'sleep', ms: 4000 },
              { do: 'mcp', tool: 'project_get', arguments: {} },
            ],
          },
        ],
      });
      startDaemon();
      await waitFor(() => server.hellos().length === 1, 20_000, 'hello');
      const payload = runStartPayload(`${git.url}/owner/notes.git`, {
        limits: { maxNudgesPerRun: 0, mcpCallTimeoutSeconds: 2 },
      });
      server.send({ type: 'run.start', id: randomUUID(), payload });
      await waitFor(
        () => server.states(payload.runId).some((state) => state.payload.state === 'ended'),
        60_000,
        'the end of the run',
      );

      const calls = server.received.filter((message) => message.type === 'mcp.call');
      expect(calls.map((call) => call.payload)).toEqual([
        { tool: 'ticket_get', runToken: payload.runToken, input: {} },
        { tool: 'ticket_list', runToken: payload.runToken, input: {} },
        { tool: 'agent_list', runToken: payload.runToken, input: {} },
        { tool: 'project_get', runToken: payload.runToken, input: {} },
      ]);
      const results = (await fake.log()).flatMap((entry) =>
        entry.event === 'mcp'
          ? [entry.result as { content: { text: string }[]; isError?: boolean }]
          : [],
      );
      expect(results.map((result) => result.isError ?? false)).toEqual([false, true, true, false]);
      expect(JSON.parse(results[0]?.content[0]?.text ?? '')).toEqual({ tool: 'ticket_get' });
      expect(JSON.parse(results[1]?.content[0]?.text ?? '')).toMatchObject({
        code: 'UNAVAILABLE',
        message: expect.stringContaining(
          'within 2 seconds (the "MCP call timeout" setting)',
        ) as unknown,
      });
      expect(JSON.parse(results[2]?.content[0]?.text ?? '')).toMatchObject({
        code: 'UNAVAILABLE',
        message: expect.stringContaining('not connected to the Orchestrator') as unknown,
      });
      expect(server.hellos()).toHaveLength(2);
    },
    TIMEOUT,
  );
});
