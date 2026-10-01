import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { writeConfig } from '../src/config.js';
import { TMUX_SOCKET_NAME } from '../src/paths.js';
import { markedProcesses, sweepRun } from '../src/processes.js';
import { UserSystemd, runScopeName, tmuxScopeName, unitPrefix } from '../src/systemd.js';
import { sessionName } from '../src/tmux.js';
import { LEFT_BEHIND, leftPids, running } from './left-behind.js';
import { startGitHttpServer } from './git-http-server.js';
import { createRemote } from './remote.js';
import {
  TIMEOUT,
  addSystemPath,
  daemon,
  ended,
  fake,
  home,
  start,
  states,
  useRunnerHarness,
} from './runner-harness.js';
import { runStartPayload } from './run-start.js';
import { ScriptedServer, TOKEN } from './scripted-server.js';
import { captureLogger, waitFor } from './testing.js';

// The systemd scopes of lot 2 plan step K (05, sections 2 and 4.11), with the host's real systemd
// user session. They run only with ORCHESTRATOR_TEST_SYSTEMD=1 (CI's runner has no user session):
// see docs/dev/testing.md. Every unit they create is named `od-test-<hash>-…` from the test home
// (`unitPrefix`), never `orchestrator-tmux` or `orchestrator-daemon`, and is stopped after each
// test and, for leftovers of an interrupted run, before the first one.

const ENABLED = process.env.ORCHESTRATOR_TEST_SYSTEMD === '1';
const SYSTEM_PATH = '/usr/bin:/bin';

/** The units of earlier test runs: every `od-test-*` unit of the user's systemd. */
function stopTestUnits(): void {
  const listed = spawnSync(
    'systemctl',
    ['--user', 'list-units', '--all', '--plain', '--no-legend', 'od-test-*'],
    { encoding: 'utf8' },
  );
  const units = listed.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0] ?? '')
    .filter((unit) => unit.startsWith('od-test-'));
  if (units.length === 0) return;
  spawnSync('systemctl', ['--user', 'stop', ...units]);
  spawnSync('systemctl', ['--user', 'reset-failed', ...units]);
}

/** The systemd cgroup path of a process: the scope or service it runs in. */
function cgroup(pid: number): string {
  return readFileSync(`/proc/${String(pid)}/cgroup`, 'utf8');
}

let systemd: UserSystemd;

describe.runIf(ENABLED)('systemd scopes (ORCHESTRATOR_TEST_SYSTEMD=1)', () => {
  useRunnerHarness();

  beforeAll(async () => {
    // The throw-away scope of the check is named like every unit of these tests.
    const found = await UserSystemd.detect(SYSTEM_PATH, process.env, 'od-test-check-');
    if (!found.systemd) {
      throw new Error(
        `ORCHESTRATOR_TEST_SYSTEMD=1, but no process scope can be created: ${found.problem}`,
      );
    }
    systemd = found.systemd;
    stopTestUnits();
  });
  afterEach(() => {
    stopTestUnits();
  });
  afterAll(() => {
    stopTestUnits();
  });

  /** The test home's sessions reach the user's systemd, as the service's do. */
  function withUserSession(): void {
    for (const name of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
      if (process.env[name]) home.env[name] = process.env[name];
    }
    addSystemPath();
  }

  it(
    "runs Claude Code in the run's scope and the tmux server in its own; the end stops both",
    async () => {
      withUserSession();
      const prefix = unitPrefix(home.paths);
      expect(prefix).toMatch(/^od-test-[0-9a-f]{8}-$/);
      const manager = daemon({ systemd });
      await fake.play({
        turns: [
          { steps: [...LEFT_BEHIND, { do: 'sleep', ms: 3000 }, { do: 'text', text: 'Done.' }] },
        ],
      });
      const run = await start(manager, { limits: { maxNudgesPerRun: 0 } });
      await waitFor(async () => (await leftPids()).length === 4, 30_000, 'the four processes');

      const [launch] = (await fake.log()).filter((entry) => entry.event === 'start');
      if (launch?.event !== 'start') throw new Error('no launch');
      expect(cgroup(launch.pid)).toContain(`/${runScopeName(prefix, run.runId)}.scope`);
      const server = spawnSync(
        join(home.bin, 'tmux'),
        ['-L', TMUX_SOCKET_NAME, 'display-message', '-p', '#{pid}'],
        { env: home.env, encoding: 'utf8' },
      );
      expect(cgroup(Number(server.stdout.trim()))).toContain(`/${tmuxScopeName(prefix)}.scope`);
      expect(await systemd.isActive(`${runScopeName(prefix, run.runId)}.scope`)).toBe(true);

      await ended(run.runId);
      const pids = await leftPids();
      await waitFor(
        () => pids.every((pid) => !running(pid, run.runId)),
        15_000,
        'the four processes stopped',
      );
      expect(markedProcesses(run.runId)).toEqual([]);
      expect(await systemd.isActive(`${runScopeName(prefix, run.runId)}.scope`)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "stops the scope of a waiting run's session closed after its lifetime",
    async () => {
      withUserSession();
      const prefix = unitPrefix(home.paths);
      const manager = daemon({ systemd, secondMs: 20 });
      await fake.play({
        turns: [
          {
            steps: [
              ...LEFT_BEHIND,
              { do: 'mcp', tool: 'ticket_ask', arguments: { question: 'Which address?' } },
            ],
          },
        ],
      });
      // One minute lasts 1.2 s; the session start is not what this test times.
      const run = await start(manager, {
        limits: {
          waitingRunLifetimeMinutes: 1,
          sessionStartTimeoutSeconds: 600,
          maxNudgesPerRun: 0,
        },
      });
      await waitFor(
        () =>
          states(run.runId).some((state) => state.state === 'waiting_human' && !state.sessionAlive),
        30_000,
        'the waiting session closed',
      );
      const pids = await leftPids();
      expect(pids).toHaveLength(4);
      await waitFor(
        () => pids.every((pid) => !running(pid, run.runId)),
        15_000,
        'the four processes stopped',
      );
      expect(await systemd.isActive(`${runScopeName(prefix, run.runId)}.scope`)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'keeps the sessions when the service restarts, and the restarted daemon finds them',
    async () => {
      withUserSession();
      const prefix = unitPrefix(home.paths);
      const service = `${prefix}daemon`;
      const tmuxDir = home.env.TMUX_TMPDIR ?? '';
      await mkdir(tmuxDir, { recursive: true, mode: 0o700 });
      const remotes = join(home.root, 'service-remotes');
      await createRemote(remotes, 'owner', 'notes', home.env);
      const git = await startGitHttpServer(remotes, {
        username: 'x-access-token',
        password: TOKEN,
      });
      const server = new ScriptedServer();
      await server.listen();
      let runId = '';
      try {
        await writeConfig(home.paths.config, {
          serverUrl: server.url,
          machineId: randomUUID(),
          machineName: 'Desktop',
          machineToken: `omt_${'d'.repeat(43)}`,
          ca: null,
        });
        await fake.play({ turns: [{ steps: [{ do: 'sleep', ms: 120_000 }] }] });

        // The daemon as a transient user service, started as the unit starts it (`--service`): its
        // cgroup is killed when it stops, as the installed unit's is (no KillMode, 05 section 2).
        // Nothing is written in the home folder.
        const root = fileURLToPath(new URL('..', import.meta.url));
        const tsxCli = createRequire(join(root, 'package.json')).resolve('tsx/cli');
        const startService = () => {
          const started = spawnSync(
            'systemd-run',
            [
              '--user',
              '--quiet',
              '--collect',
              '--unit',
              service,
              `--working-directory=${home.root}`,
              ...[
                'HOME',
                'ORCHESTRATOR_HOME',
                'XDG_CONFIG_HOME',
                'PATH',
                'TMUX_TMPDIR',
                'XDG_RUNTIME_DIR',
                'LANG',
                'LOG_LEVEL',
              ].flatMap((name) =>
                home.env[name] === undefined ? [] : [`--setenv=${name}=${home.env[name]}`],
              ),
              '--',
              process.execPath,
              tsxCli,
              '--conditions=source',
              join(root, 'src', 'cli.ts'),
              'start',
              '--service',
            ],
            { encoding: 'utf8' },
          );
          expect(started.status, started.stderr).toBe(0);
        };

        startService();
        await waitFor(() => server.hellos().length === 1, 30_000, 'hello');
        // The service created its throw-away scope: it takes runs (05, section 2).
        expect(
          server.hellos()[0]?.payload.doctor.find((check) => check.name === 'Process scopes'),
        ).toMatchObject({ status: 'ok' });
        const payload = runStartPayload(`${git.url}/owner/notes.git`);
        runId = payload.runId;
        server.send({ type: 'run.start', id: randomUUID(), payload });
        await waitFor(
          () => server.states(runId).some((state) => state.payload.state === 'working'),
          60_000,
          'the working state',
        );
        const [launch] = (await fake.log()).filter((entry) => entry.event === 'start');
        if (launch?.event !== 'start') throw new Error('no launch');

        // The restart: stopping the service kills its whole cgroup.
        const stopped = spawnSync('systemctl', ['--user', 'stop', `${service}.service`], {
          encoding: 'utf8',
        });
        expect(stopped.status, stopped.stderr).toBe(0);
        await waitFor(
          async () => !(await systemd.isActive(`${service}.service`)),
          20_000,
          'the service stopped',
        );
        const hasSession = spawnSync(
          join(home.bin, 'tmux'),
          ['-L', TMUX_SOCKET_NAME, 'has-session', '-t', `=${sessionName(runId)}`],
          { env: home.env },
        );
        expect(hasSession.status).toBe(0);
        expect(running(launch.pid, runId)).toBe(true);

        startService();
        await waitFor(() => server.hellos().length === 2, 30_000, 'the second hello');
        expect(server.hellos()[1]?.payload.runs).toEqual([
          { runId, state: 'working', claudeSessionId: expect.any(String) as unknown },
        ]);
      } finally {
        spawnSync('systemctl', ['--user', 'stop', `${service}.service`]);
        spawnSync(join(home.bin, 'tmux'), ['-L', TMUX_SOCKET_NAME, 'kill-server'], {
          env: home.env,
        });
        if (runId) await sweepRun(runId, captureLogger().log, 1000);
        await server.close();
        await git.close();
      }
    },
    TIMEOUT * 2,
  );
});

describe.skipIf(ENABLED)('systemd scopes', () => {
  it.skip('run with ORCHESTRATOR_TEST_SYSTEMD=1 on a machine with a systemd user session', () => {
    // See docs/dev/testing.md, "systemd tests".
  });
});
