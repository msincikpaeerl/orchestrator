import { execFileSync } from 'node:child_process';
import { BRANCH_REPORT_MAX_COMMITS } from '@orchestrator/protocol';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Git } from '../src/git.js';
import { TrustRegistry } from '../src/trust.js';
import { Workspaces } from '../src/workspace.js';
import { createRemote, gitIn } from './remote.js';
import { prepareTicketRun, runStartPayload } from './run-start.js';
import {
  DAEMON_COMMAND,
  captureLogger,
  createTestHome,
  linkSystemTool,
  stopHomeProcesses,
  type TestHome,
} from './testing.js';

// Preparation of an `implement` or `fix_review` run's worktree when the ticket branch is both on
// this machine and on GitHub (05, section 4.2; lot 3 step D2): fast-forwarded to GitHub's when
// GitHub's contains it, left as it is when they diverged (its push then reports it), and never
// moved while a waiting or paused run has it checked out.

const BRANCH = 't/1-add-notes';

let home: TestHome;
let remote: string;
let spaces: Workspaces;

beforeEach(async () => {
  home = await createTestHome();
  await linkSystemTool(home.bin, 'git');
  remote = await createRemote(join(home.root, 'remotes'), 'owner', 'notes', home.env);
  spaces = new Workspaces({
    paths: home.paths,
    git: new Git(join(home.bin, 'git'), home.env),
    trust: new TrustRegistry(join(home.paths.claudeConfig, '.claude.json')),
    credentials: () => Promise.resolve({ ok: false, message: 'file:// asks for none' }),
    selfCommand: DAEMON_COMMAND,
    log: captureLogger().log,
  });
});

afterEach(async () => {
  await stopHomeProcesses(home);
  await home.remove();
});

async function prepare() {
  const start = runStartPayload(`file://${remote}`);
  const folder = join(home.paths.home, 'runs', start.runId);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  return { start, folder, ...(await prepareTicketRun(spaces, start, folder)) };
}

function head(repository: string, ref: string): string {
  return gitIn(repository, ['rev-parse', '--verify', ref], home.env).trim();
}

function commit(worktree: string, message: string): string {
  gitIn(worktree, ['commit', '--quiet', '--allow-empty', '-m', message], home.env);
  return head(worktree, 'HEAD');
}

/** Runs `change` in a clone of GitHub's ticket branch, then pushes it back. */
async function onGitHub(change: (clone: string) => void): Promise<string> {
  const clone = await mkdtemp(join(home.root, 'github-'));
  gitIn(clone, ['clone', '--quiet', remote, '.'], home.env);
  gitIn(clone, ['checkout', '--quiet', BRANCH], home.env);
  change(clone);
  gitIn(clone, ['push', '--quiet', 'origin', `HEAD:refs/heads/${BRANCH}`], home.env);
  const pushed = head(clone, 'HEAD');
  await rm(clone, { recursive: true, force: true });
  return pushed;
}

/** GitHub's **Update branch**: the base branch merged into the ticket branch. */
function updateBranch(clone: string): void {
  gitIn(clone, ['checkout', '--quiet', 'main'], home.env);
  gitIn(clone, ['commit', '--quiet', '--allow-empty', '-m', 'Merged on main meanwhile'], home.env);
  gitIn(clone, ['push', '--quiet', 'origin', 'main'], home.env);
  gitIn(clone, ['checkout', '--quiet', BRANCH], home.env);
  gitIn(clone, ['merge', '--quiet', '--no-edit', 'main'], home.env);
}

describe('preparation', () => {
  it("fast-forwards the local ticket branch to GitHub's after Update branch", async () => {
    const first = await prepare();
    const pushed = commit(first.worktree, 'Agent work');
    expect(await spaces.push(first.start, first.bare, first.folder, pushed)).toEqual({
      status: 'pushed',
      head: pushed,
    });
    await spaces.remove(first.bare, first.worktree);
    const updated = await onGitHub(updateBranch);

    const second = await prepare();
    expect(head(second.bare, `refs/heads/${BRANCH}`)).toBe(updated);
    expect(head(second.worktree, 'HEAD')).toBe(updated);
    expect(gitIn(second.worktree, ['symbolic-ref', 'HEAD'], home.env).trim()).toBe(
      `refs/heads/${BRANCH}`,
    );
    // Nothing of this machine's is lost: the pushed commit is in the new head's history.
    expect(gitIn(second.worktree, ['merge-base', '--is-ancestor', pushed, 'HEAD'], home.env)).toBe(
      '',
    );
  }, 30_000);

  it('leaves a diverged branch as it is, and its push reports it without overwriting GitHub', async () => {
    const first = await prepare();
    gitIn(
      first.worktree,
      ['push', '--quiet', `file://${remote}`, `HEAD:refs/heads/${BRANCH}`],
      home.env,
    );
    const local = commit(first.worktree, 'Only on this machine');
    await spaces.remove(first.bare, first.worktree);
    const theirs = await onGitHub((clone) => {
      gitIn(clone, ['commit', '--quiet', '--allow-empty', '-m', 'Only on GitHub'], home.env);
    });

    const second = await prepare();
    expect(head(second.bare, `refs/heads/${BRANCH}`)).toBe(local);
    expect(head(second.worktree, 'HEAD')).toBe(local);
    expect(await spaces.endPush(second.start, second.bare, second.folder)).toMatchObject({
      status: 'failed',
      reason: 'diverged',
    });
    expect(head(remote, `refs/heads/${BRANCH}`)).toBe(theirs);
  }, 30_000);

  it('never moves a branch a waiting run has checked out, which keeps working', async () => {
    const waiting = await prepare();
    const pushed = commit(waiting.worktree, 'Before the question');
    await spaces.push(waiting.start, waiting.bare, waiting.folder, pushed);
    const updated = await onGitHub(updateBranch);

    // Another run of the same ticket on this machine (the server never starts one: one active
    // run per ticket; here the daemon protects the branch by itself).
    const refused = await prepare().then(
      () => 'prepared',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(refused).toMatch(
      new RegExp(`^The ticket branch ${BRANCH} is checked out by another run on this machine`),
    );
    expect(head(waiting.bare, `refs/heads/${BRANCH}`)).toBe(pushed);
    expect(head(waiting.worktree, 'HEAD')).toBe(pushed);
    expect(updated).not.toBe(pushed);
    // The waiting run's worktree still commits on its branch, with its author.
    execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'After the answer'], {
      cwd: waiting.worktree,
      env: home.env,
    });
    const after = head(waiting.worktree, 'HEAD');
    expect(head(waiting.bare, `refs/heads/${BRANCH}`)).toBe(after);
    expect(gitIn(waiting.worktree, ['log', '-1', '--format=%an'], home.env).trim()).toBe(
      'Web Developer (Orchestrator)',
    );
  }, 30_000);
});

// What a branch report says is not on GitHub, and the end push's decision: one rule, computed by
// the same code (05, section 4.9; lot 3 step D3).
describe('commits not on GitHub', () => {
  /** The report's list, and whether the end push then pushes: they must always agree. */
  async function both(run: Awaited<ReturnType<typeof prepare>>) {
    const report = await spaces.branchReport(run.bare, run.start.repository);
    if (!report) throw new Error('no branch report');
    const push = await spaces.endPush(run.start, run.bare, run.folder);
    expect(report.notOnGitHub).not.toBeNull();
    expect((report.notOnGitHub?.count ?? 0) > 0).toBe(push !== null);
    return { report, push };
  }

  it('agrees with the end push in every case', async () => {
    // A new branch from GitHub's base: nothing.
    const fresh = await prepare();
    expect((await both(fresh)).report.notOnGitHub).toEqual({ listed: [], count: 0 });

    // A commit of this machine: listed, and pushed.
    const local = commit(fresh.worktree, 'Agent work');
    const pushed = await both(fresh);
    expect(pushed.report.notOnGitHub).toEqual({ listed: [local], count: 1 });
    expect(pushed.push).toEqual({ status: 'pushed', head: local });
    // Pushed: nothing left, as the end report reads it again after the push.
    expect((await both(fresh)).report.notOnGitHub).toEqual({ listed: [], count: 0 });
    await spaces.remove(fresh.bare, fresh.worktree);

    // GitHub's Update branch, taken at preparation: its merge commit came from GitHub.
    const updated = await onGitHub(updateBranch);
    const second = await prepare();
    const afterUpdate = await both(second);
    expect(afterUpdate.report.head).toBe(updated);
    expect(afterUpdate.report.commitsAhead.map((each) => each.hash)).toContain(updated);
    expect(afterUpdate.report.notOnGitHub).toEqual({ listed: [], count: 0 });
    expect(afterUpdate.push).toBeNull();
    await spaces.remove(second.bare, second.worktree);

    // A commit on another branch fetched from GitHub only: on GitHub, so nothing to push.
    const clone = await mkdtemp(join(home.root, 'github-'));
    gitIn(clone, ['clone', '--quiet', remote, '.'], home.env);
    gitIn(clone, ['checkout', '--quiet', '-b', 'other', `origin/${BRANCH}`], home.env);
    const elsewhere = commit(clone, 'On another branch');
    gitIn(clone, ['push', '--quiet', 'origin', 'other'], home.env);
    await rm(clone, { recursive: true, force: true });
    const third = await prepare();
    gitIn(third.worktree, ['merge', '--quiet', '--ff-only', 'origin/other'], home.env);
    const otherBranch = await both(third);
    expect(otherBranch.report.head).toBe(elsewhere);
    expect(otherBranch.report.notOnGitHub).toEqual({ listed: [], count: 0 });
    expect(otherBranch.push).toBeNull();
  }, 60_000);

  /** Adds `count` commits of this machine on top of the ticket branch, in one Git command. */
  function manyCommits(bare: string, from: string, count: number): void {
    let stream = '';
    for (let index = 0; index < count; index++) {
      const message = `Commit ${String(index)}`;
      stream += `commit refs/heads/${BRANCH}\ncommitter Test <test@example.com> ${String(1_700_000_000 + index)} +0000\ndata ${String(Buffer.byteLength(message))}\n${message}\n`;
      if (index === 0) stream += `from ${from}\n`;
      stream += '\n';
    }
    execFileSync('git', ['-C', bare, 'fast-import', '--quiet'], { input: stream, env: home.env });
  }

  for (const extra of [0, 1]) {
    it(`lists the ${String(BRANCH_REPORT_MAX_COMMITS)} newest commits and counts all ${String(BRANCH_REPORT_MAX_COMMITS + extra)}`, async () => {
      const run = await prepare();
      manyCommits(
        run.bare,
        head(run.bare, `refs/heads/${BRANCH}`),
        BRANCH_REPORT_MAX_COMMITS + extra,
      );
      const report = await spaces.branchReport(run.bare, run.start.repository);
      expect(report?.commitsAhead).toHaveLength(BRANCH_REPORT_MAX_COMMITS);
      expect(report?.commitsAhead[0]?.subject).toBe(
        `Commit ${String(BRANCH_REPORT_MAX_COMMITS + extra - 1)}`,
      );
      expect(report?.notOnGitHub?.listed).toEqual(report?.commitsAhead.map((each) => each.hash));
      expect(report?.notOnGitHub?.count).toBe(BRANCH_REPORT_MAX_COMMITS + extra);
    }, 60_000);
  }
});
