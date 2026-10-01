import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ack, DoctorCheck, MachineDoctor } from '@orchestrator/protocol';
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
  fakeExecutable,
  linkSystemTool,
  runDaemon,
  spawnDaemon,
  stopHomeProcesses,
  waitFor,
  type DaemonProcess,
  type TestHome,
} from './testing.js';

// Process scopes (05, sections 2 and 8; lot 2 plan step M2), with fake `systemd-run` and
// `systemctl`: the service without scopes reports an error and starts no session; a daemon in a
// terminal keeps the fallback; a run's scope failing later fails the run and blocks the machine.
// `systemd.test.ts` checks the real scopes on a host with a systemd user session.

const TIMEOUT = 90_000;
const REFUSAL = 'Failed to start transient scope unit: Access denied';
let home: TestHome;
let fake: FakeClaude;
let server: ScriptedServer;
let git: GitHttpServer;
let daemons: DaemonProcess[];
/** While this file exists, the fake `systemd-run` refuses the scopes `refused` names. */
let broken: string;
/**
 * While this file exists, the fake `systemd-run` of a run's scope writes `called`, then waits two
 * seconds before starting Claude Code: a launch a test can interrupt.
 */
let slow: string;
let called: string;

beforeEach(async () => {
  home = await createTestHome();
  await linkSystemTool(home.bin, 'git');
  await linkSystemTool(home.bin, 'tmux');
  fake = await installFakeClaude(home.bin, join(home.root, 'fake'));
  const tmuxDir = join(home.root, 'tmux');
  await mkdir(tmuxDir, { mode: 0o700 });
  home.env.TMUX_TMPDIR = tmuxDir;
  home.env.PATH = `${home.env.PATH ?? ''}:/usr/bin:/bin`;
  broken = join(home.root, 'scopes-broken');
  slow = join(home.root, 'scopes-slow');
  called = join(home.root, 'systemd-run-called');
  await fakeExecutable(home.bin, 'systemctl', 'exit 0');
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

/**
 * A fake `systemd-run --user --scope … --unit <unit> -- <command>`: runs the command where a scope
 * would hold it, or, while `broken` exists and the unit's name matches the shell pattern
 * `refused`, fails as systemd does when it refuses a scope. While `slow` exists, a run's scope
 * starts two seconds late.
 */
async function fakeSystemdRun(refused: string): Promise<void> {
  await fakeExecutable(
    home.bin,
    'systemd-run',
    [
      'unit=',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    --unit) unit=$2; shift 2 ;;',
      '    --) shift; break ;;',
      '    *) shift ;;',
      '  esac',
      'done',
      `if [ -e '${broken}' ]; then`,
      `  case "$unit" in ${refused}) printf '%s\\n' '${REFUSAL}' >&2; exit 1 ;; esac`,
      'fi',
      `if [ -e '${slow}' ]; then`,
      `  case "$unit" in *orch-run-*) : > '${called}'; sleep 2 ;; esac`,
      'fi',
      'exec "$@"',
    ].join('\n'),
  );
}

function startDaemon(mode: 'service' | 'terminal'): DaemonProcess {
  const daemon = spawnDaemon(mode === 'service' ? ['start', '--service'] : ['start'], home.env);
  daemons.push(daemon);
  return daemon;
}

function scopesCheck(doctor: DoctorCheck[]): DoctorCheck | undefined {
  return doctor.find((check) => check.name === 'Process scopes');
}

/** Sends a command and resolves with its `ack`. */
async function command(
  message: { type: 'run.start' | 'run.resume'; payload: object },
  what: string,
): Promise<Ack['payload']> {
  const id = randomUUID();
  server.send({ ...message, id } as Parameters<ScriptedServer['send']>[0]);
  let answer: Ack['payload'] | undefined;
  await waitFor(
    () => {
      const ack = server.received.find(
        (received): received is Ack => received.type === 'ack' && received.id === id,
      );
      answer = ack?.payload;
      return ack !== undefined;
    },
    10_000,
    `the ack of ${what}`,
  );
  if (!answer) throw new Error('no ack');
  return answer;
}

function payload() {
  return runStartPayload(`${git.url}/owner/notes.git`, { limits: { maxNudgesPerRun: 0 } });
}

async function runFolders(): Promise<string[]> {
  return readdir(join(home.paths.home, 'runs')).catch(() => []);
}

describe('process scopes', () => {
  it(
    'the service without scopes reports an error, refuses run.start and starts nothing',
    async () => {
      await fakeSystemdRun('*');
      await writeFile(broken, '');
      startDaemon('service');
      await waitFor(() => server.hellos().length === 1, 20_000, 'hello');

      const check = scopesCheck(server.hellos()[0]?.payload.doctor ?? []);
      expect(check).toMatchObject({
        status: 'error',
        link: `${server.url}/help/machines#process-scopes`,
      });
      expect(check?.message).toContain(`systemd-run --user --scope failed: ${REFUSAL}`);
      expect(check?.message).toContain('systemctl --user restart orchestrator-daemon');

      const answer = await command({ type: 'run.start', payload: payload() }, 'run.start');
      expect(answer).toEqual({ ok: false, message: check?.message });
      // Nothing started: no run folder, no Claude Code, no tmux server.
      expect(await runFolders()).toEqual([]);
      expect(await fake.log()).toEqual([]);
      expect(
        spawnSync(join(home.bin, 'tmux'), ['-L', TMUX_SOCKET_NAME, 'list-sessions'], {
          env: home.env,
        }).status,
      ).not.toBe(0);

      const status = await runDaemon(['status'], home.env);
      expect(status.stdout).toMatch(
        /running as the service[\s\S]*ERROR {4}Process scopes: Process scopes cannot be created/,
      );
      const doctor = await runDaemon(['doctor'], home.env);
      expect(doctor.code).toBe(1);
      expect(doctor.stdout).toMatch(/ERROR {4}Process scopes: Process scopes cannot be created/);
    },
    TIMEOUT,
  );

  it(
    'a daemon in a terminal without scopes keeps the fallback: no check, runs start',
    async () => {
      await fakeSystemdRun('*');
      await writeFile(broken, '');
      startDaemon('terminal');
      await waitFor(() => server.hellos().length === 1, 20_000, 'hello');
      expect(scopesCheck(server.hellos()[0]?.payload.doctor ?? [])).toBeUndefined();

      const start = payload();
      expect(await command({ type: 'run.start', payload: start }, 'run.start')).toEqual({
        ok: true,
      });
      await waitFor(
        () => server.states(start.runId).some((state) => state.payload.state === 'ended'),
        60_000,
        'the end of the run',
      );
      const end = server.states(start.runId).at(-1)?.payload;
      expect(end).toMatchObject({ state: 'ended', reason: 'nudges_exhausted' });
      expect((await fake.log()).some((entry) => entry.event === 'start')).toBe(true);
      expect((await runDaemon(['status'], home.env)).stdout).not.toContain('Process scopes');
      expect((await runDaemon(['doctor'], home.env)).stdout).not.toContain('Process scopes');
    },
    TIMEOUT,
  );

  it.each([
    ["a run's scope", '*orch-run-*'],
    ["the tmux server's scope", '*orchestrator-tmux*'],
  ])(
    '%s refused later fails the run and blocks the machine until the restart',
    async (_, refused) => {
      // The check at start passes; the scope `refused` names fails once `broken` exists.
      await fakeSystemdRun(refused);
      startDaemon('service');
      await waitFor(() => server.hellos().length === 1, 20_000, 'hello');
      expect(scopesCheck(server.hellos()[0]?.payload.doctor ?? [])).toMatchObject({
        status: 'ok',
      });

      await writeFile(broken, '');
      const start = payload();
      expect(await command({ type: 'run.start', payload: start }, 'run.start')).toEqual({
        ok: true,
      });
      await waitFor(
        () => server.states(start.runId).some((state) => state.payload.state === 'ended'),
        60_000,
        'the end of the run',
      );
      const end = server.states(start.runId).at(-1)?.payload;
      expect(end).toMatchObject({ state: 'ended', reason: 'process_scope_failed' });
      expect(end?.state === 'ended' ? end.detail : null).toContain(
        `Claude Code could not be started in the run's process scope (systemd-run --user --scope failed: ${REFUSAL})`,
      );
      expect((await fake.log()).some((entry) => entry.event === 'start')).toBe(false);

      // Reported at once, not at the next connection.
      await waitFor(
        () => server.received.some((message) => message.type === 'machine.doctor'),
        10_000,
        'machine.doctor',
      );
      const report = server.received.find(
        (message): message is MachineDoctor => message.type === 'machine.doctor',
      );
      const check = scopesCheck(report?.payload.doctor ?? []);
      expect(check?.status).toBe('error');
      expect(check?.message).toContain('Process scopes could not be created for a run');
      expect(server.hellos()).toHaveLength(1);

      const next = payload();
      expect(await command({ type: 'run.start', payload: next }, 'run.start')).toEqual({
        ok: false,
        message: check?.message,
      });
      expect(existsSync(join(home.paths.home, 'runs', next.runId))).toBe(false);
      expect(
        await command(
          {
            type: 'run.resume',
            payload: { runId: start.runId, claudeSessionId: randomUUID(), message: 'Go on.' },
          },
          'run.resume',
        ),
      ).toEqual({ ok: false, message: check?.message });
      expect((await runDaemon(['status'], home.env)).stdout).toContain(
        'ERROR    Process scopes: Process scopes could not be created for a run',
      );
    },
    TIMEOUT,
  );

  /** The machine still takes runs: no error reported, the next run.start accepted. */
  async function notBlocked(): Promise<void> {
    expect(server.received.some((message) => message.type === 'machine.doctor')).toBe(false);
    expect((await runDaemon(['status'], home.env)).stdout).toContain(
      "OK       Process scopes: Used: agents' sessions keep running when the service restarts",
    );
    expect(await command({ type: 'run.start', payload: payload() }, 'run.start')).toEqual({
      ok: true,
    });
  }

  /** Starts a run whose scope starts late, and resolves once systemd-run was called. */
  async function slowLaunch(): Promise<string> {
    await fakeSystemdRun('*');
    await writeFile(slow, '');
    startDaemon('service');
    await waitFor(() => server.hellos().length === 1, 20_000, 'hello');
    const start = payload();
    expect(await command({ type: 'run.start', payload: start }, 'run.start')).toEqual({
      ok: true,
    });
    await waitFor(() => existsSync(called), 30_000, 'systemd-run called for the run');
    return start.runId;
  }

  async function endOf(runId: string) {
    await waitFor(
      () => server.states(runId).some((state) => state.payload.state === 'ended'),
      30_000,
      'the end of the run',
    );
    return server.states(runId).at(-1)?.payload;
  }

  it(
    'Stop run during the launch does not block the machine',
    async () => {
      const runId = await slowLaunch();
      server.send({
        type: 'run.stop',
        id: randomUUID(),
        payload: { runId, reason: 'owner_stopped' },
      });
      expect(await endOf(runId)).toMatchObject({ state: 'ended', reason: 'stopped' });
      await rm(slow);
      await notBlocked();
    },
    TIMEOUT,
  );

  it(
    'the session closed during the launch is not a scope failure',
    async () => {
      const runId = await slowLaunch();
      // tmux, not systemd, ends it: systemd-run stops on the hang-up without refusing anything.
      spawnSync(
        join(home.bin, 'tmux'),
        ['-L', TMUX_SOCKET_NAME, 'kill-session', '-t', `=orch-${runId}`],
        {
          env: home.env,
        },
      );
      expect(await endOf(runId)).toMatchObject({ state: 'ended', reason: 'crashed' });
      await rm(slow);
      await notBlocked();
    },
    TIMEOUT,
  );

  it(
    'a daemon stopped during the launch does not block the machine after its restart',
    async () => {
      const runId = await slowLaunch();
      const first = daemons[0];
      first?.child.kill('SIGTERM');
      expect(await first?.exited).toBe(0);
      await rm(slow);
      startDaemon('service');
      await waitFor(() => server.hellos().length === 2, 20_000, 'the second hello');
      expect(scopesCheck(server.hellos()[1]?.payload.doctor ?? [])).toMatchObject({
        status: 'ok',
      });
      // The launch went on without the daemon: the restarted one finds the session.
      expect(server.hellos()[1]?.payload.runs.map((run) => run.runId)).toEqual([runId]);
      await notBlocked();
    },
    TIMEOUT,
  );
});
