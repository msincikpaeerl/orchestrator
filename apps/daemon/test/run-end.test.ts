import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitCredentialRequest, RunStart } from '@orchestrator/protocol';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import type { CredentialAnswer } from '../src/credentials.js';
import type { RunManager } from '../src/runs.js';
import { sessionName } from '../src/tmux.js';
import { bareClonePath, worktreePath } from '../src/workspace.js';
import type { ScenarioInput } from './fake-claude/scenario.js';
import { startGitHttpServer, type GitHttpServer } from './git-http-server.js';
import { gitIn } from './remote.js';
import {
  TIMEOUT,
  daemon,
  ended,
  fake,
  home,
  otherMachine,
  start,
  states,
  tmux,
  useRunnerHarness,
} from './runner-harness.js';
import { waitFor } from './testing.js';

// The push at a run's end (05, sections 4.9 and 4.11; lot 3 step D2), with the real tmux and Git,
// the fake `claude`, and the Git test server asking for the credential: on every way a run can
// end with commits not on GitHub, the branch appears on the server; the push comes after the
// session, the run's processes and the worktree are gone, and its result is in the end report.

useRunnerHarness();

const TOKEN = 'ghp_RunEndTestTokenThatMustNeverBeStored01';
const CREDENTIAL = { username: 'x-access-token', password: TOKEN };
const BRANCH = 't/1-add-notes';
const COMMIT = 'echo notes > notes.md && git add notes.md && git commit -q -m "Add notes"';

let server: GitHttpServer | null = null;
let asked: GitCredentialRequest['payload'][] = [];

afterEach(async () => {
  await server?.close();
  server = null;
  asked = [];
});

async function serve(options: { delayPushMs?: number } = {}): Promise<string> {
  server = await startGitHttpServer(join(home.root, 'remotes'), CREDENTIAL, options);
  return `${server.url}/owner/notes.git`;
}

/** A daemon whose scripted server gives the credential, or answers a push with `push`. */
function credentialedDaemon(
  options: Parameters<typeof daemon>[0] = {},
  push: CredentialAnswer = { ok: true, ...CREDENTIAL },
): RunManager {
  return daemon({
    ...options,
    credentials: (request) => {
      asked.push(request);
      return Promise.resolve(request.command === 'push' ? push : { ok: true, ...CREDENTIAL });
    },
  });
}

const remote = () => join(home.root, 'remotes', 'owner', 'notes.git');

function remoteHead(ref: string): string | null {
  try {
    return gitIn(remote(), ['rev-parse', '--verify', '--quiet', ref], home.env).trim();
  } catch {
    return null;
  }
}

function localHead(runStart: RunStart['payload'], ref = `refs/heads/${BRANCH}`): string | null {
  try {
    const bare = bareClonePath(home.paths, runStart.repository);
    return gitIn(bare, ['rev-parse', '--verify', '--quiet', ref], home.env).trim();
  } catch {
    return null;
  }
}

/** Waits for the agent's commit on the local ticket branch. */
async function committed(runStart: RunStart['payload']): Promise<string> {
  await waitFor(
    () => localHead(runStart) !== null && localHead(runStart) !== remoteHead('refs/heads/main'),
    20_000,
    "the agent's commit",
  );
  return localHead(runStart) ?? '';
}

function stop(manager: RunManager, runId: string, reason: 'owner_stopped' | 'ticket_cancelled') {
  return manager.handle({ type: 'run.stop', id: randomUUID(), payload: { runId, reason } });
}

/** Whether a process of the run (its marker in the environment) is still alive. */
async function runProcessAlive(runId: string): Promise<boolean> {
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    const environment = await readFile(`/proc/${pid}/environ`).catch(() => null);
    if (environment?.includes(`ORCHESTRATOR_RUN_ID=${runId}`)) return true;
  }
  return false;
}

interface Way {
  name: string;
  scenario: ScenarioInput;
  secondMs?: number;
  limits?: Partial<RunStart['payload']['limits']>;
  /** Ends the run from the server's side, once the agent committed. */
  stop?: 'owner_stopped' | 'ticket_cancelled';
  reason: string;
}

const HANG: ScenarioInput = {
  turns: [{ steps: [{ do: 'bash', command: COMMIT }, { do: 'hang' }] }],
};

const WAYS: Way[] = [
  {
    name: 'a failure (Claude Code exits)',
    scenario: {
      turns: [
        {
          steps: [
            { do: 'bash', command: COMMIT },
            { do: 'exit', code: 1 },
          ],
        },
      ],
    },
    reason: 'crashed',
  },
  {
    name: 'a give-up',
    scenario: {
      turns: [
        {
          steps: [
            { do: 'bash', command: COMMIT },
            { do: 'mcp', tool: 'ticket_give_up', arguments: { reason: 'Stop.', tried: 'This.' } },
          ],
        },
      ],
    },
    reason: 'gave_up',
  },
  {
    name: 'the idle timeout',
    scenario: HANG,
    secondMs: 100,
    limits: { idleTimeoutMinutes: 1, sessionStartTimeoutSeconds: 600 },
    reason: 'idle_timeout',
  },
  {
    name: 'Longest run',
    scenario: HANG,
    secondMs: 100,
    limits: { maxRunDurationMinutes: 1, idleTimeoutMinutes: 120, sessionStartTimeoutSeconds: 600 },
    reason: 'max_duration',
  },
  {
    name: 'reminders used up',
    scenario: {
      turns: [
        {
          steps: [
            { do: 'bash', command: COMMIT },
            { do: 'text', text: 'Hm.' },
          ],
        },
      ],
    },
    limits: { maxNudgesPerRun: 0 },
    reason: 'nudges_exhausted',
  },
  { name: 'Stop run', scenario: HANG, stop: 'owner_stopped', reason: 'stopped' },
  { name: 'a cancelled ticket', scenario: HANG, stop: 'ticket_cancelled', reason: 'stopped' },
];

describe('the end push', () => {
  for (const way of WAYS) {
    it(
      `pushes the ticket branch with its credential at ${way.name}`,
      async () => {
        const cloneUrl = await serve();
        const manager = credentialedDaemon({ secondMs: way.secondMs });
        await fake.play(way.scenario);
        const run = await start(manager, { repository: { cloneUrl }, limits: way.limits });
        const head = await committed(run);
        if (way.stop) expect(await stop(manager, run.runId, way.stop)).toEqual({ ok: true });
        await waitFor(
          () => remoteHead(`refs/heads/${BRANCH}`) === head,
          30_000,
          'the branch on the Git server',
        );
        const end = await ended(run.runId);
        expect(end).toMatchObject({ reason: way.reason, push: { status: 'pushed', head } });
        expect(asked.filter((request) => request.command === 'push')).toEqual([
          { runId: run.runId, repository: { owner: 'owner', name: 'notes' }, command: 'push' },
        ]);
        // The bare clone knows the head is on GitHub now.
        expect(localHead(run, `refs/remotes/origin/${BRANCH}`)).toBe(head);
      },
      TIMEOUT,
    );
  }

  it(
    'pushes nothing when every commit is on GitHub already, nor after an accepted submission',
    async () => {
      const cloneUrl = await serve();
      const manager = credentialedDaemon();
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'mcp', tool: 'ticket_give_up', arguments: { reason: 'Stop.', tried: 'This.' } },
            ],
          },
        ],
      });
      const run = await start(manager, { repository: { cloneUrl } });
      expect(await ended(run.runId)).toMatchObject({ reason: 'gave_up', push: null });
      expect(asked.filter((request) => request.command === 'push')).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'leaves the outcome unchanged when the push fails, reporting why',
    async () => {
      const cloneUrl = await serve();
      const manager = credentialedDaemon({}, { ok: false, message: 'the run is cancelled' });
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'bash', command: COMMIT },
              { do: 'mcp', tool: 'ticket_give_up', arguments: { reason: 'Stop.', tried: 'This.' } },
            ],
          },
        ],
      });
      const run = await start(manager, { repository: { cloneUrl } });
      const end = await ended(run.runId);
      expect(end).toMatchObject({
        reason: 'gave_up',
        push: {
          status: 'failed',
          reason: 'refused',
          message: 'The Orchestrator refused the credential: the run is cancelled',
        },
      });
      expect(remoteHead(`refs/heads/${BRANCH}`)).toBeNull();
    },
    TIMEOUT,
  );

  it(
    'comes after the session, the processes and the worktree are gone, and is stopped at Longest push',
    async () => {
      const cloneUrl = await serve({ delayPushMs: 30_000 });
      const manager = credentialedDaemon();
      await fake.play(HANG);
      const run = await start(manager, {
        repository: { cloneUrl },
        limits: { pushTimeoutSeconds: 5 },
      });
      await committed(run);
      // Acknowledged once the run has ended.
      const stopped = stop(manager, run.runId, 'owner_stopped');
      await waitFor(
        () => server?.requests.some((request) => request.push) ?? false,
        20_000,
        'the push reaching the Git server',
      );
      const pushStarted = Date.now();
      // While the push waits: no end reported, no session, no worktree, no process of the run.
      expect(states(run.runId).some((state) => state.state === 'ended')).toBe(false);
      expect(await tmux.hasSession(sessionName(run.runId))).toBe(false);
      expect(existsSync(worktreePath(home.paths, run.runId))).toBe(false);
      expect(await runProcessAlive(run.runId)).toBe(false);
      const end = await ended(run.runId);
      expect(Date.now() - pushStarted).toBeLessThan(9_000);
      expect(await stopped).toEqual({ ok: true });
      expect(end).toMatchObject({
        reason: 'stopped',
        push: {
          status: 'failed',
          reason: 'unreachable',
          message: 'The push took longer than Longest push (5 seconds) and was stopped.',
        },
      });
    },
    TIMEOUT,
  );
});

// Lot 3 step D3: once a branch is on GitHub, Run now may give the next run to any machine (07,
// section 3), which takes the branch from GitHub.
describe('another machine', () => {
  it(
    'takes a branch pushed by the first one from GitHub, and continues it',
    async () => {
      const cloneUrl = await serve();
      // Appends: each run's commit changes the file.
      const append = 'echo $$ >> notes.md && git add notes.md && git commit -q -m "More notes"';
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'bash', command: append },
              { do: 'exit', code: 1 },
            ],
          },
        ],
      });
      const laptop = credentialedDaemon();
      const first = await start(laptop, { repository: { cloneUrl } });
      const pushed = await ended(first.runId);
      expect(pushed).toMatchObject({ reason: 'crashed', push: { status: 'pushed' } });
      // Read again after the push: nothing is left only on Laptop (lot 3 step D3).
      expect(pushed.branch?.notOnGitHub).toEqual({ listed: [], count: 0 });
      const head = remoteHead(`refs/heads/${BRANCH}`);
      expect(head).not.toBeNull();

      // Desk has never cloned the project: no local branch.
      const machine = await otherMachine('desk');
      onTestFinished(machine.close);
      const desk = credentialedDaemon({ paths: machine.paths, tmux: machine.tmux });
      const second = await start(desk, { repository: { cloneUrl } });
      const end = await ended(second.runId);
      expect(end).toMatchObject({ reason: 'crashed', push: { status: 'pushed' } });
      const next = remoteHead(`refs/heads/${BRANCH}`);
      expect(next).not.toBe(head);
      // Desk's commit is on top of Laptop's: the run went on from the branch on GitHub.
      expect(remoteHead(`${next ?? ''}^`)).toBe(head);
      expect(end.branch?.commitsAhead.map((commit) => commit.hash)).toEqual([next, head]);
      expect(existsSync(bareClonePath(machine.paths, second.repository))).toBe(true);
      expect(existsSync(bareClonePath(home.paths, second.repository))).toBe(true);
    },
    TIMEOUT,
  );
});

// Lot 3 step D3: commits that came from GitHub are never reported as not on GitHub.
describe('a branch updated on GitHub', () => {
  it(
    'reports the merge commit of Update branch as on GitHub when the run adds nothing',
    async () => {
      const cloneUrl = await serve();
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'bash', command: COMMIT },
              { do: 'exit', code: 1 },
            ],
          },
        ],
      });
      const manager = credentialedDaemon();
      const first = await start(manager, { repository: { cloneUrl } });
      expect(await ended(first.runId)).toMatchObject({ push: { status: 'pushed' } });

      // GitHub's Update branch: the base branch merged into the ticket branch, on GitHub.
      const clone = await mkdtemp(join(home.root, 'github-'));
      gitIn(clone, ['clone', '--quiet', remote(), '.'], home.env);
      gitIn(
        clone,
        ['commit', '--quiet', '--allow-empty', '-m', 'Merged on main meanwhile'],
        home.env,
      );
      gitIn(clone, ['push', '--quiet', 'origin', 'main'], home.env);
      gitIn(clone, ['checkout', '--quiet', BRANCH], home.env);
      gitIn(clone, ['merge', '--quiet', '--no-edit', 'main'], home.env);
      gitIn(clone, ['push', '--quiet', 'origin', BRANCH], home.env);
      const merged = gitIn(clone, ['rev-parse', 'HEAD'], home.env).trim();
      await rm(clone, { recursive: true, force: true });

      // The next run is fast-forwarded to it at preparation, and commits nothing.
      await fake.play({ turns: [{ steps: [{ do: 'exit', code: 1 }] }] });
      const second = await start(manager, { repository: { cloneUrl } });
      const end = await ended(second.runId);
      expect(end).toMatchObject({ reason: 'crashed', push: null });
      expect(end.branch?.head).toBe(merged);
      expect(end.branch?.commitsAhead.map((each) => each.hash)).toContain(merged);
      expect(end.branch?.notOnGitHub).toEqual({ listed: [], count: 0 });
    },
    TIMEOUT,
  );
});
