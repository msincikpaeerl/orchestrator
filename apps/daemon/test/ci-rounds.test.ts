import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DodReport, GitCredentialRequest, RunStart } from '@orchestrator/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { CredentialAnswer } from '../src/credentials.js';
import type { RunManager } from '../src/runs.js';
import { stateFilePath } from '../src/run-files.js';
import { sessionName } from '../src/tmux.js';
import { bareClonePath } from '../src/workspace.js';
import { startGitHttpServer, type GitHttpServer } from './git-http-server.js';
import { gitIn } from './remote.js';
import {
  TIMEOUT,
  answerTools,
  daemon,
  ended,
  fake,
  home,
  messagesReceived,
  start,
  states,
  tmux,
  useRunnerHarness,
} from './runner-harness.js';
import { waitFor } from './testing.js';

// A CI result sent back to a run waiting for CI (05, sections 4.4 and 4.9; lot 3 step G2a): the
// failure pasted into the live session, the run working again and handing its work in again; a
// closed session resumed with it; and for a conflict, the base branch downloaded from GitHub
// before the message (`fetchBase`), through the isolated fetch, acknowledged only afterwards.

useRunnerHarness();

const TOKEN = 'ghp_CiRoundsTestTokenThatMustNeverBeStored1';
const CREDENTIAL = { username: 'x-access-token', password: TOKEN };

const SUBMISSION: DodReport = {
  criteria: [{ index: 0, status: 'met', justification: 'Notes are saved.' }],
  tests: { paths: [], justification: 'No code.' },
  docs: { paths: [], justification: 'No user-visible change.' },
  adrs: [],
  summary: 'Adds notes.',
};

const COMMIT = 'echo notes > notes.md && git add notes.md && git commit -q -m "Add notes"';
const FIX = 'echo fixed >> notes.md && git commit -q -am "Fix the notes"';
const MERGE = 'git merge --no-edit -q origin/main';
const FAILURE = 'CI failed on GitHub for the commit you handed in.';
const CONFLICT = 'Your pull request conflicts with main: run git merge origin/main.';

const submitStep = { do: 'mcp' as const, tool: 'ticket_submit', arguments: SUBMISSION };

let server: GitHttpServer | null = null;
let asked: GitCredentialRequest['payload'][] = [];

afterEach(async () => {
  await server?.close();
  server = null;
  asked = [];
});

function pendingCi(): void {
  answerTools((call) =>
    call.tool === 'ticket_submit'
      ? { ok: true, output: { result: 'pending_ci', ticket: {} } }
      : { ok: true, output: {} },
  );
}

const remote = () => join(home.root, 'remotes', 'owner', 'notes.git');

async function serve(): Promise<string> {
  server = await startGitHttpServer(join(home.root, 'remotes'), CREDENTIAL);
  return `${server.url}/owner/notes.git`;
}

/** A daemon whose scripted server answers the `n`-th credential request with `answer(n)`. */
function credentialedDaemon(
  options: Parameters<typeof daemon>[0] = {},
  answer: (index: number) => CredentialAnswer = () => ({ ok: true, ...CREDENTIAL }),
): RunManager {
  return daemon({
    ...options,
    credentials: (request) => {
      asked.push(request);
      return Promise.resolve(answer(asked.length - 1));
    },
  });
}

/** Someone adds a commit to `branch` on GitHub (another ticket merged into `main`). */
async function commitOnGitHub(branch: string, file: string): Promise<string> {
  const work = await mkdtemp(join(home.root, 'elsewhere-'));
  gitIn(home.root, ['clone', '--quiet', remote(), work], home.env);
  gitIn(work, ['checkout', '--quiet', '-B', branch], home.env);
  await writeFile(join(work, file), `${file}\n`);
  gitIn(work, ['add', file], home.env);
  gitIn(work, ['commit', '--quiet', '-m', `Add ${file}`], home.env);
  gitIn(work, ['push', '--quiet', 'origin', `${branch}:${branch}`], home.env);
  const head = gitIn(work, ['rev-parse', 'HEAD'], home.env).trim();
  await rm(work, { recursive: true, force: true });
  return head;
}

function bareRef(runStart: RunStart['payload'], ref: string): string | null {
  try {
    const bare = bareClonePath(home.paths, runStart.repository);
    return gitIn(bare, ['rev-parse', '--verify', '--quiet', ref], home.env).trim();
  } catch {
    return null;
  }
}

function remoteRef(ref: string): string {
  return gitIn(remote(), ['rev-parse', ref], home.env).trim();
}

function isAncestor(ancestor: string, of: string): boolean {
  try {
    gitIn(remote(), ['merge-base', '--is-ancestor', ancestor, of], home.env);
    return true;
  } catch {
    return false;
  }
}

function input(manager: RunManager, runId: string, text: string, fetchBase?: boolean) {
  return manager.handle({
    type: 'run.input',
    id: randomUUID(),
    payload: { runId, text, ...(fetchBase === undefined ? {} : { fetchBase }) },
  });
}

function stop(manager: RunManager, runId: string) {
  return manager.handle({
    type: 'run.stop',
    id: randomUUID(),
    payload: { runId, reason: 'completed' },
  });
}

/** The run's `n`-th report of `waiting_ci` (1 for the first). */
async function waitingCi(runId: string, count = 1): Promise<void> {
  await waitFor(
    () => states(runId).filter((state) => state.state === 'waiting_ci').length >= count,
    30_000,
    `the run waiting for CI (${String(count)})`,
  );
}

describe('a CI result sent back to a run waiting for CI', () => {
  it(
    'pastes a failure into the live session; the agent works and hands in again, with no reminder while waiting',
    async () => {
      pendingCi();
      // One minute of a setting lasts 4.8 s, as in waiting-ci.test.ts: the idle timeout passes
      // twice in each wait, and no reminder may reach the session.
      const manager = daemon({ secondMs: 80 });
      await fake.play({
        turns: [
          { steps: [{ do: 'bash', command: COMMIT }, submitStep] },
          { steps: [{ do: 'bash', command: FIX }, submitStep] },
        ],
      });
      const run = await start(manager, {
        limits: {
          maxRunDurationMinutes: 10,
          idleTimeoutMinutes: 1,
          maxNudgesPerRun: 2,
          sessionStartTimeoutSeconds: 600,
        },
      });
      const file = stateFilePath(home.paths, run.runId);
      const worked = () =>
        (JSON.parse(readFileSync(file, 'utf8')) as { workingMs: number }).workingMs;
      const idleTwice = async (what: string) => {
        const since = Date.now();
        await waitFor(() => Date.now() - since > 2 * 4800, 30_000, what);
      };

      await waitingCi(run.runId);
      const before = worked();
      await idleTwice('the idle timeout passed twice in the first wait');
      expect(worked()).toBe(before);

      expect(await input(manager, run.runId, FAILURE)).toEqual({ ok: true });
      await waitFor(
        () =>
          states(run.runId).some(
            (state, index, all) =>
              state.state === 'working' &&
              all.slice(0, index).some((s) => s.state === 'waiting_ci'),
          ),
        20_000,
        'the run working again',
      );
      await waitingCi(run.runId, 2);
      const second = worked();
      await idleTwice('the idle timeout passed twice in the second wait');
      expect(worked()).toBe(second);
      expect(states(run.runId).at(-1)?.state).toBe('waiting_ci');

      expect(await stop(manager, run.runId)).toEqual({ ok: true });
      expect((await ended(run.runId)).reason).toBe('submitted');
      // The first message and the failure: no reminder in either wait.
      expect(await messagesReceived()).toEqual(['Implement ticket NOTES-1.', FAILURE]);
    },
    TIMEOUT,
  );

  it(
    'refuses a message to a closed session, and resumes it with run.resume and the base branch downloaded first',
    async () => {
      pendingCi();
      const cloneUrl = await serve();
      const manager = credentialedDaemon({ secondMs: 50 });
      await fake.play({ turns: [{ steps: [{ do: 'bash', command: COMMIT }, submitStep] }] });
      const run = await start(manager, {
        repository: { cloneUrl },
        limits: { sessionStartTimeoutSeconds: 600 },
      });
      await waitingCi(run.runId);
      // Claude Code goes away during the wait.
      await tmux.killSession(sessionName(run.runId));
      await waitFor(
        () =>
          states(run.runId).some((state) => state.state === 'waiting_ci' && !state.sessionAlive),
        30_000,
        'the wait reported with its session closed',
      );
      expect(await input(manager, run.runId, CONFLICT, true)).toEqual({
        ok: false,
        message: 'session closed: use run.resume',
      });

      const mainHead = await commitOnGitHub('main', 'base.md');
      const sessionId = states(run.runId).at(-1)?.claudeSessionId ?? '';
      await fake.play({ turns: [{ steps: [{ do: 'bash', command: MERGE }, submitStep] }] });
      asked.length = 0;
      expect(
        await manager.handle({
          type: 'run.resume',
          id: randomUUID(),
          payload: {
            runId: run.runId,
            claudeSessionId: sessionId,
            message: CONFLICT,
            fetchBase: true,
          },
        }),
      ).toEqual({ ok: true });
      // Downloaded before the session got the message: the agent's merge brings main's commit.
      await waitingCi(run.runId, 3);
      expect(asked.map((request) => request.command)).toEqual(['fetch', 'push']);
      expect(isAncestor(mainHead, remoteRef('refs/heads/t/1-add-notes'))).toBe(true);
      expect(await stop(manager, run.runId)).toEqual({ ok: true });
      expect((await ended(run.runId)).reason).toBe('submitted');
    },
    TIMEOUT,
  );

  it(
    'downloads only the base branch before a live session gets the conflict, and acknowledges afterwards',
    async () => {
      pendingCi();
      const cloneUrl = await serve();
      const manager = credentialedDaemon();
      await fake.play({
        turns: [
          { steps: [{ do: 'bash', command: COMMIT }, submitStep] },
          { steps: [{ do: 'bash', command: MERGE }, submitStep] },
        ],
      });
      const run = await start(manager, { repository: { cloneUrl } });
      await waitingCi(run.runId);
      const mainHead = await commitOnGitHub('main', 'base.md');
      await commitOnGitHub('other', 'other.md');
      expect(bareRef(run, 'refs/remotes/origin/main')).not.toBe(mainHead);
      asked.length = 0;

      expect(await input(manager, run.runId, CONFLICT, true)).toEqual({ ok: true });
      // Acknowledged once downloaded: the base branch is there already.
      expect(bareRef(run, 'refs/remotes/origin/main')).toBe(mainHead);
      // Only the base branch: another branch of GitHub is not brought in.
      expect(bareRef(run, 'refs/remotes/origin/other')).toBeNull();
      expect(asked[0]).toMatchObject({ command: 'fetch', runId: run.runId });

      await waitingCi(run.runId, 2);
      expect(asked.map((request) => request.command)).toEqual(['fetch', 'push']);
      expect(isAncestor(mainHead, remoteRef('refs/heads/t/1-add-notes'))).toBe(true);
      expect(await messagesReceived()).toEqual(['Implement ticket NOTES-1.', CONFLICT]);
      expect(await stop(manager, run.runId)).toEqual({ ok: true });
      expect((await ended(run.runId)).reason).toBe('submitted');
    },
    TIMEOUT,
  );

  it(
    'refuses the message when the base branch cannot be downloaded, and the agent gets nothing',
    async () => {
      pendingCi();
      const cloneUrl = await serve();
      // The preparation's fetch and the submission's push get the credential; later ones not.
      const manager = credentialedDaemon({}, (index) =>
        index < 2 ? { ok: true, ...CREDENTIAL } : { ok: false, message: 'the run is failed' },
      );
      await fake.play({ turns: [{ steps: [{ do: 'bash', command: COMMIT }, submitStep] }] });
      const run = await start(manager, { repository: { cloneUrl } });
      await waitingCi(run.runId);
      await commitOnGitHub('main', 'base.md');
      const before = bareRef(run, 'refs/remotes/origin/main');

      const refused = await input(manager, run.runId, CONFLICT, true);
      expect(refused.ok).toBe(false);
      const message = refused.ok ? '' : refused.message;
      expect(message).toMatch(/^Downloading main from GitHub failed: /);
      expect(message).toContain('The Orchestrator refused the credential: the run is failed');
      expect(message).not.toContain(TOKEN);

      // GitHub unreachable.
      await server?.close();
      server = null;
      const unreachable = await input(manager, run.runId, CONFLICT, true);
      expect(unreachable.ok).toBe(false);
      expect(unreachable.ok ? '' : unreachable.message).toMatch(
        /^Downloading main from GitHub failed: /,
      );

      expect(bareRef(run, 'refs/remotes/origin/main')).toBe(before);
      expect(states(run.runId).at(-1)?.state).toBe('waiting_ci');
      expect(await messagesReceived()).toEqual(['Implement ticket NOTES-1.']);
      expect(await stop(manager, run.runId)).toEqual({ ok: true });
      expect((await ended(run.runId)).reason).toBe('submitted');
    },
    TIMEOUT,
  );
});
