import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ack, DoctorCheck, MachineDoctor, RunQuotaLimited } from '@orchestrator/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearLoginExpired, LOGGED_OUT } from '../src/claude-login.js';
import { writeConfig } from '../src/config.js';
import { requestRecheck } from '../src/control.js';
import { TMUX_SOCKET_NAME } from '../src/paths.js';
import { installFakeClaude, type FakeClaude } from './fake-claude/install.js';
import type { ScenarioInput } from './fake-claude/scenario.js';
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

// An expired Claude Code login (05, sections 4.10 and 8; lot 5 step M2b), with the daemon, the
// fake `claude` and a scripted server: a turn ending on Claude Code's login error ends the run
// `claude_login_expired` with no pause, the machine reports its login check as an error at once
// and refuses runs, and the next login makes it usable again. The agent's own words never count.

const TIMEOUT = 90_000;
const LOGIN = 'Login expired · Please run /login';
let home: TestHome;
let fake: FakeClaude;
let server: ScriptedServer;
let git: GitHttpServer;
let daemon: DaemonProcess | null;

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
  daemon = null;
});

afterEach(async () => {
  if (daemon) {
    daemon.child.kill('SIGTERM');
    await daemon.exited;
  }
  spawnSync(join(home.bin, 'tmux'), ['-L', TMUX_SOCKET_NAME, 'kill-server'], { env: home.env });
  await stopHomeProcesses(home);
  await server.close();
  await git.close();
  await home.remove();
});

const loginCheck = (doctor: DoctorCheck[]) =>
  doctor.find((check) => check.name === 'Claude Code login');

const doctors = () =>
  server.received.filter((message): message is MachineDoctor => message.type === 'machine.doctor');

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
      answer = server.received.find(
        (received): received is Ack => received.type === 'ack' && received.id === id,
      )?.payload;
      return answer !== undefined;
    },
    10_000,
    `the ack of ${what}`,
  );
  if (!answer) throw new Error('no ack');
  return answer;
}

function payload() {
  return runStartPayload(`${git.url}/owner/notes.git`, { limits: { maxNudgesPerRun: 1 } });
}

/** Starts the daemon in a terminal, plays `scenario` in a run, and resolves with its end. */
async function runEnding(scenario: ScenarioInput) {
  daemon = spawnDaemon(['start'], home.env);
  await waitFor(() => server.hellos().length === 1, 20_000, 'hello');
  expect(loginCheck(server.hellos()[0]?.payload.doctor ?? [])?.status).toBe('ok');
  await fake.play(scenario);
  const start = payload();
  expect(await command({ type: 'run.start', payload: start }, 'run.start')).toEqual({ ok: true });
  await waitFor(
    () => server.states(start.runId).some((state) => state.payload.state === 'ended'),
    60_000,
    'the end of the run',
  );
  const quota = server.received.filter(
    (message): message is RunQuotaLimited => message.type === 'run.quota_limited',
  );
  return {
    start,
    end: server.states(start.runId).at(-1)?.payload,
    paused: server.states(start.runId).some((state) => state.payload.state === 'quota_paused'),
    quota,
  };
}

describe('an expired Claude Code login', () => {
  it(
    'ends the run claude_login_expired with no pause, and blocks the machine until the next login',
    async () => {
      const { start, end, paused, quota } = await runEnding({
        turns: [
          {
            steps: [{ do: 'text', text: 'Working.' }],
            end: { kind: 'stopFailure', error: 'authentication_failed', message: LOGIN },
          },
        ],
      });
      expect(end).toMatchObject({ state: 'ended', reason: 'claude_login_expired' });
      expect(end?.state === 'ended' ? end.detail : null).toBe(
        `Claude Code is logged out on this machine ("${LOGIN}"): type "orchestrator-daemon login" on the machine and log in with the Claude account of this machine. It is not the ticket's fault and does not count as a failed attempt.`,
      );
      expect(paused).toBe(false);
      expect(quota).toEqual([]);
      // No nudge: only the first message reached the agent.
      const messages = (await fake.log()).filter((entry) => entry.event === 'message');
      expect(messages).toHaveLength(1);
      expect(existsSync(home.paths.loginExpired)).toBe(true);

      // Reported at once, not at the next connection.
      await waitFor(() => doctors().length === 1, 10_000, 'machine.doctor');
      expect(loginCheck(doctors()[0]?.payload.doctor ?? [])).toMatchObject({
        status: 'error',
        message: LOGGED_OUT,
      });
      expect(server.hellos()).toHaveLength(1);
      const next = payload();
      expect(await command({ type: 'run.start', payload: next }, 'run.start')).toEqual({
        ok: false,
        message: LOGGED_OUT,
      });
      expect(
        await command(
          {
            type: 'run.resume',
            payload: { runId: start.runId, claudeSessionId: randomUUID(), message: 'Go on.' },
          },
          'run.resume',
        ),
      ).toEqual({ ok: false, message: LOGGED_OUT });
      const doctor = await runDaemon(['doctor'], home.env);
      expect(doctor.code).toBe(1);
      expect(doctor.stdout).toContain(`ERROR    Claude Code login: ${LOGGED_OUT}`);

      // What `orchestrator-daemon login` does once Claude Code exits normally (commands.test.ts).
      clearLoginExpired(home.paths);
      expect(await requestRecheck(home.paths.controlSocket)).toBe(true);
      await waitFor(() => doctors().length === 2, 10_000, 'machine.doctor after the login');
      expect(loginCheck(doctors()[1]?.payload.doctor ?? [])?.status).toBe('ok');
      expect(await command({ type: 'run.start', payload: payload() }, 'run.start')).toEqual({
        ok: true,
      });
    },
    TIMEOUT,
  );

  it(
    'is read from the transcript entry Claude Code marked as an API error',
    async () => {
      const { end, paused } = await runEnding({
        turns: [{ steps: [{ do: 'apiError', text: LOGIN }] }],
      });
      expect(end).toMatchObject({ state: 'ended', reason: 'claude_login_expired' });
      expect(paused).toBe(false);
      await waitFor(() => doctors().length === 1, 10_000, 'machine.doctor');
    },
    TIMEOUT,
  );

  it(
    "never from the agent's own words: the run goes on and the machine stays usable",
    async () => {
      // A ticket about a login page: the agent says the text, runs a command printing it, and
      // writes it in a file. One nudge, then the usual end.
      const said = 'The page now says "Session over · Please run /login" when the token is gone.';
      const { end, paused } = await runEnding({
        turns: [
          {
            steps: [
              { do: 'bash', command: `printf '%s\\n' 'Please run /login' > login.txt` },
              { do: 'bash', command: 'cat login.txt' },
              { do: 'text', text: said },
            ],
          },
          { steps: [{ do: 'text', text: said }] },
        ],
      });
      expect(end).toMatchObject({ state: 'ended', reason: 'nudges_exhausted' });
      expect(paused).toBe(false);
      const messages = (await fake.log()).filter((entry) => entry.event === 'message');
      expect(messages).toHaveLength(2);
      expect(existsSync(home.paths.loginExpired)).toBe(false);
      expect(doctors()).toEqual([]);
      expect(await command({ type: 'run.start', payload: payload() }, 'run.start')).toEqual({
        ok: true,
      });
    },
    TIMEOUT,
  );
});
