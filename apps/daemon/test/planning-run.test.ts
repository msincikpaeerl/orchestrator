import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { McpPermission, runMcpTools, type RunStart } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { stateFilePath } from '../src/run-files.js';
import type { RunManager } from '../src/runs.js';
import { sessionName } from '../src/tmux.js';
import { bareClonePath, worktreePath } from '../src/workspace.js';
import { gitIn } from './remote.js';
import { runStartPayload } from './run-start.js';
import {
  TIMEOUT,
  cloneUrl,
  daemon,
  ended,
  fake,
  home,
  states,
  tmux,
  useRunnerHarness,
} from './runner-harness.js';
import { waitFor } from './testing.js';

// Planning runs (protocol 3, lot 5 step B2; 05, section 4.2), with the real tmux and Git and the
// fake `claude`, started through the scripted server's `run.start` (no server code starts one
// before step E2): a new project's run in an empty scratch folder with no Git, an existing
// project's in a worktree detached at GitHub's base branch; neither reports a branch nor pushes,
// and the clean-up removes either.

useRunnerHarness();

const remote = () => join(home.root, 'remotes', 'owner', 'notes.git');

function head(repository: string, ref: string): string | null {
  try {
    return gitIn(repository, ['rev-parse', '--verify', '--quiet', ref], home.env).trim();
  } catch {
    return null;
  }
}

/** A planning run's `run.start`: the request as subject, no ticket branch, no repository if new. */
function planningPayload(project: 'new' | 'existing'): RunStart['payload'] {
  const { repository, ...ticketRun } = runStartPayload(cloneUrl, {
    purpose: 'plan',
    subject: { kind: 'request', id: randomUUID() },
    initialPrompt: 'Plan the request.',
    mcpTools: runMcpTools(McpPermission.options, 'plan'),
    profile: {
      key: 'pm',
      version: 1,
      instructions: 'You plan requests.',
      model: 'sonnet',
      allowedTools: ['Bash(git log *)', 'Bash(git status *)'],
    },
  });
  if (project === 'new') return ticketRun;
  const { owner, name, cloneUrl: url, baseBranch } = repository;
  return { ...ticketRun, repository: { owner, name, cloneUrl: url, baseBranch } };
}

async function startPlanning(
  manager: RunManager,
  project: 'new' | 'existing',
): Promise<RunStart['payload']> {
  const payload = planningPayload(project);
  expect(await manager.handle({ type: 'run.start', id: randomUUID(), payload })).toEqual({
    ok: true,
  });
  return payload;
}

const working = (runId: string) =>
  waitFor(
    () => states(runId).some((state) => state.state === 'working'),
    20_000,
    'the planning session',
  );

async function bashRuns(): Promise<{ command: string; exitCode: number; output: string }[]> {
  return (await fake.log()).flatMap((entry) => (entry.event === 'bash' ? [entry] : []));
}

const stop = (manager: RunManager, runId: string) =>
  manager.handle({
    type: 'run.stop',
    id: randomUUID(),
    payload: { runId, reason: 'owner_stopped' },
  });

async function trusted(path: string): Promise<boolean> {
  const config = JSON.parse(
    await readFile(join(home.paths.claudeConfig, '.claude.json'), 'utf8'),
  ) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> };
  return config.projects?.[path]?.hasTrustDialogAccepted === true;
}

describe('a planning run of a new project', () => {
  it(
    'starts in an empty scratch folder with no Git, trusted for its own path, removed at the end',
    async () => {
      // The daemon's folder inside a Git repository, as a home folder under Git would be: Git
      // must still find none from the scratch folder (GIT_CEILING_DIRECTORIES, 05 section 4.3).
      await mkdir(home.paths.home, { recursive: true });
      gitIn(home.paths.home, ['init', '--quiet'], home.env);
      const manager = daemon();
      await fake.play({
        turns: [{ steps: [{ do: 'bash', command: 'git status --short' }, { do: 'hang' }] }],
      });
      const run = await startPlanning(manager, 'new');
      await working(run.runId);
      await waitFor(async () => (await bashRuns()).length > 0, 20_000, 'the git command');

      const scratch = worktreePath(home.paths, run.runId);
      const [launch] = (await fake.log()).filter((entry) => entry.event === 'start');
      expect(launch).toMatchObject({
        cwd: scratch,
        env: { GIT_CEILING_DIRECTORIES: join(home.paths.home, 'worktrees') },
      });
      expect(await readdir(scratch)).toEqual([]);
      const [status] = await bashRuns();
      expect(status?.exitCode).not.toBe(0);
      expect(status?.output).toContain('not a git repository');
      expect(await trusted(scratch)).toBe(true);
      // No clone of anything: no repository was named.
      expect(existsSync(join(home.paths.home, 'repos'))).toBe(false);
      expect(manager.list()).toEqual([
        {
          runId: run.runId,
          state: 'working',
          claudeSessionId: expect.any(String) as string,
          ticket: null,
          request: run.subject.id,
          repository: null,
          branch: null,
        },
      ]);

      expect(await stop(manager, run.runId)).toEqual({ ok: true });
      expect(await ended(run.runId)).toMatchObject({
        reason: 'stopped',
        branch: null,
        push: null,
        headMoved: null,
        gitConfigRestored: null,
      });
      expect(existsSync(scratch)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'waits after request_ask, keeps its scratch folder, and a resume starts there again',
    async () => {
      // One minute lasts 1.2 s.
      const manager = daemon({ secondMs: 20 });
      // `request_ask` waits as `ticket_ask` does (lot 5 step D2a).
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'bash', command: 'echo notes > notes.txt' },
              { do: 'mcp', tool: 'request_ask', arguments: { question: 'Which pages?' } },
            ],
          },
        ],
      });
      const payload = planningPayload('new');
      const run = {
        ...payload,
        limits: {
          ...payload.limits,
          waitingRunLifetimeMinutes: 1,
          sessionStartTimeoutSeconds: 600,
          maxNudgesPerRun: 0,
        },
      };
      expect(await manager.handle({ type: 'run.start', id: randomUUID(), payload: run })).toEqual({
        ok: true,
      });
      await waitFor(
        () => states(run.runId).some((s) => s.state === 'waiting_human' && !s.sessionAlive),
        20_000,
        'the session closed',
      );
      const waiting = states(run.runId).at(-1);
      expect(await tmux.hasSession(sessionName(run.runId))).toBe(false);
      const scratch = worktreePath(home.paths, run.runId);
      expect(await readdir(scratch)).toEqual(['notes.txt']);

      await fake.play({ turns: [{ steps: [{ do: 'text', text: 'Planning the pages.' }] }] });
      expect(
        await manager.handle({
          type: 'run.resume',
          id: randomUUID(),
          payload: {
            runId: run.runId,
            claudeSessionId: waiting?.claudeSessionId ?? '',
            message: 'The owner answered: two pages.',
          },
        }),
      ).toEqual({ ok: true });
      expect((await ended(run.runId)).reason).toBe('nudges_exhausted');
      const launches = (await fake.log()).flatMap((entry) =>
        entry.event === 'start' ? [entry.cwd] : [],
      );
      expect(launches).toEqual([scratch, scratch]);
      expect(existsSync(scratch)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'has its scratch folder removed at the next start when the daemon stopped while preparing it',
    async () => {
      const first = daemon();
      await fake.play({ turns: [{ steps: [{ do: 'hang' }] }] });
      const run = await startPlanning(first, 'new');
      await working(run.runId);
      await first.shutdown();
      // As if the daemon had stopped after making the folder, before recording it.
      await tmux.killSession(sessionName(run.runId));
      const file = stateFilePath(home.paths, run.runId);
      const state = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      await writeFile(file, JSON.stringify({ ...state, state: 'preparing', worktree: null }));
      const scratch = worktreePath(home.paths, run.runId);
      expect(existsSync(scratch)).toBe(true);

      const second = daemon();
      await second.recover();
      expect(await ended(run.runId)).toMatchObject({
        reason: 'crashed',
        detail: 'The daemon stopped while it prepared the workspace.',
        branch: null,
      });
      expect(existsSync(scratch)).toBe(false);
    },
    TIMEOUT,
  );
});

describe('a planning run of an existing project', () => {
  it(
    "works detached at GitHub's base branch, creates no branch, reports none and never pushes",
    async () => {
      const github = head(remote(), 'refs/heads/main');
      const manager = daemon();
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'bash', command: 'git status --short' },
              // Even a commit (the Project Manager has no tool for one) is neither reported nor
              // pushed, and a changed setting of the bare clone is restored.
              { do: 'bash', command: 'git commit --quiet --allow-empty -m "Not a plan"' },
              { do: 'bash', command: 'git config core.hooksPath .husky' },
              {
                do: 'mcp',
                tool: 'ticket_give_up',
                arguments: { reason: 'Stop.', tried: 'This.' },
              },
            ],
          },
        ],
      });
      const run = await startPlanning(manager, 'existing');
      await waitFor(async () => (await bashRuns()).length === 3, 20_000, 'the git commands');
      const worktree = worktreePath(home.paths, run.runId);
      const bare = bareClonePath(home.paths, { owner: 'owner', name: 'notes' });
      const [status, commit] = await bashRuns();
      expect(status?.exitCode).toBe(0);
      expect(commit?.exitCode).toBe(0);
      // Detached, from GitHub's head of the base branch.
      expect(head(worktree, 'HEAD^')).toBe(github);
      expect(() => gitIn(worktree, ['symbolic-ref', '--quiet', 'HEAD'], home.env)).toThrow();
      expect(await trusted(bare)).toBe(true);

      expect(await ended(run.runId)).toMatchObject({
        reason: 'gave_up',
        branch: null,
        push: null,
        headMoved: null,
        gitConfigRestored: expect.stringContaining('core.hookspath') as string,
      });
      expect(existsSync(worktree)).toBe(false);
      // No local branch at all, nothing new on GitHub, and Git forgot the worktree.
      expect(gitIn(bare, ['for-each-ref', 'refs/heads'], home.env)).toBe('');
      expect(gitIn(remote(), ['for-each-ref', '--format=%(refname)'], home.env).trim()).toBe(
        'refs/heads/main',
      );
      expect(head(remote(), 'refs/heads/main')).toBe(github);
      expect(gitIn(bare, ['worktree', 'list', '--porcelain'], home.env)).not.toContain(run.runId);
    },
    TIMEOUT,
  );

  it(
    'fails its preparation when the base branch is not on GitHub',
    async () => {
      const manager = daemon();
      const payload = planningPayload('existing');
      if (!payload.repository) throw new Error('an existing project has a repository');
      const run = { ...payload, repository: { ...payload.repository, baseBranch: 'develop' } };
      expect(await manager.handle({ type: 'run.start', id: randomUUID(), payload: run })).toEqual({
        ok: true,
      });
      expect(await ended(run.runId)).toMatchObject({
        reason: 'crashed',
        detail:
          'The workspace could not be prepared: The base branch develop is not on GitHub: there is nothing to plan from.',
        branch: null,
      });
      expect(existsSync(worktreePath(home.paths, run.runId))).toBe(false);
    },
    TIMEOUT,
  );
});
