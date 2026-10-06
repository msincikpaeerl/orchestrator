import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitHubRefusal, GitHubResult } from '../src/github/answers.js';
import { listCommitRuns, listRunJobs, readCommitStatus, readJobLogEnd } from '../src/github/ci.js';
import {
  createGitHubClient,
  GitHubUnreachableError,
  type GitHubClient,
} from '../src/github/client.js';
import {
  closePullRequest,
  deleteBranch,
  findPullRequests,
  isPullRequestMerged,
  openPullRequest,
  postReview,
  readPullRequest,
  reopenPullRequest,
  updatePullRequest,
} from '../src/github/pull-requests.js';
import {
  fullAccount,
  skeletonWorkflow,
  startFakeGitHub,
  type FakeAccount,
  type FakeGitHub,
  type FakeRepository,
} from './fake-github.js';

// The GitHub layer of lot 3 (plan, step E1) against the fake GitHub: each function, and each
// refusal it returns. The owner's smoke script runs the same functions on the real GitHub.

const TOKEN = 'github_pat_layer_test_0123456789';
const SHOP = { owner: 'octo-owner', name: 'shop' };

let github: FakeGitHub;
let repo: FakeRepository;
let account: FakeAccount;
let client: GitHubClient;

beforeEach(async () => {
  github = await startFakeGitHub();
  repo = { name: 'shop', private: true, workflows: [skeletonWorkflow()] };
  account = fullAccount({ repositories: [repo] });
  github.accounts.set(TOKEN, account);
  client = clientWith(TOKEN);
});

afterEach(async () => {
  await github.close();
});

function clientWith(token: string, apiUrl = github.url): GitHubClient {
  return createGitHubClient({ apiUrl, token, timeoutSeconds: 10 });
}

function value<T>(result: GitHubResult<T>): T {
  if (!result.ok) throw new Error(`GitHub refused: ${JSON.stringify(result.refusal)}`);
  return result.value;
}

function refusal(result: GitHubResult<unknown>): GitHubRefusal {
  if (result.ok) throw new Error(`GitHub accepted: ${JSON.stringify(result.value)}`);
  return result.refusal;
}

/** The account's permissions, with `changes` applied. */
function permissions(changes: FakeAccount['permissions']): void {
  account.permissions = { ...account.permissions, ...changes };
}

function branchWith(branch: string, files: Record<string, string>): string {
  return github.commit(repo, branch, files, `Work on ${branch}`, 'main');
}

async function openCart() {
  const head = branchWith('t/1-cart', { 'cart.md': 'Cart\n' });
  const pull = value(
    await openPullRequest(client, SHOP, {
      head: 't/1-cart',
      base: 'main',
      title: '1: Cart',
      body: 'Report',
    }),
  );
  return { head, pull };
}

describe('pull requests', () => {
  it('are opened with mergeable unknown, then read with it computed', async () => {
    const { head, pull } = await openCart();
    expect(pull).toMatchObject({
      number: 1,
      state: 'open',
      title: '1: Cart',
      body: 'Report',
      headBranch: 't/1-cart',
      headSha: head,
      baseBranch: 'main',
      merged: false,
      mergeable: null,
      mergedAt: null,
    });
    expect(pull.url).toBe(`${github.url}/octo-owner/shop/pull/1`);
    expect(github.pullRequest(repo, 1).draft).toBe(false);
    expect(value(await readPullRequest(client, SHOP, 1))).toMatchObject({
      mergeable: true,
      mergeableState: 'clean',
    });
  });

  it('refuse a second open one for the same branch, saying it exists', async () => {
    await openCart();
    const second = refusal(
      await openPullRequest(client, SHOP, { head: 't/1-cart', base: 'main', title: 'x', body: '' }),
    );
    expect(second).toEqual({
      kind: 'invalid',
      status: 422,
      message: 'Validation Failed: A pull request already exists for octo-owner:t/1-cart.',
      details: ['A pull request already exists for octo-owner:t/1-cart.'],
    });
  });

  it('are updated, closed, found closed, reopened and found open', async () => {
    await openCart();
    expect(
      value(await updatePullRequest(client, SHOP, 1, { title: '1: Cart v2', body: 'New' })),
    ).toMatchObject({ title: '1: Cart v2', body: 'New' });
    expect(value(await closePullRequest(client, SHOP, 1))).toMatchObject({
      state: 'closed',
      merged: false,
    });
    expect(value(await findPullRequests(client, SHOP, 't/1-cart', 'open'))).toEqual([]);
    expect(value(await findPullRequests(client, SHOP, 't/1-cart'))).toMatchObject([
      { number: 1, state: 'closed', mergedAt: null },
    ]);
    expect(value(await isPullRequestMerged(client, SHOP, 1))).toBe(false);
    expect(value(await reopenPullRequest(client, SHOP, 1)).state).toBe('open');
    expect(value(await findPullRequests(client, SHOP, 't/1-cart', 'open'))).toMatchObject([
      { number: 1, state: 'open' },
    ]);
    expect(value(await findPullRequests(client, SHOP, 't/2-other'))).toEqual([]);
  });

  it('are read as merged after the owner merges, and cannot be reopened', async () => {
    await openCart();
    const merge = github.mergePullRequest(repo, 1);
    expect(value(await isPullRequestMerged(client, SHOP, 1))).toBe(true);
    expect(value(await readPullRequest(client, SHOP, 1))).toMatchObject({
      state: 'closed',
      merged: true,
      mergeCommitSha: merge,
    });
    expect(value(await findPullRequests(client, SHOP, 't/1-cart'))[0]?.mergedAt).not.toBeNull();
    expect(refusal(await reopenPullRequest(client, SHOP, 1))).toMatchObject({
      kind: 'invalid',
      status: 422,
    });
  });

  it('read as not mergeable when the base branch changes the same lines', async () => {
    branchWith('t/1-cart', { 'README.md': 'Branch\n' });
    value(
      await openPullRequest(client, SHOP, { head: 't/1-cart', base: 'main', title: 'x', body: '' }),
    );
    github.commit(repo, 'main', { 'README.md': 'Base\n' }, 'Base change');
    expect(value(await readPullRequest(client, SHOP, 1)).mergeable).toBeNull();
    expect(value(await readPullRequest(client, SHOP, 1))).toMatchObject({
      mergeable: false,
      mergeableState: 'dirty',
    });
  });

  it('return each refusal: rejected token, missing permission, not found', async () => {
    branchWith('t/1-cart', { 'cart.md': 'Cart\n' });
    expect(refusal(await readPullRequest(clientWith('github_pat_wrong'), SHOP, 1))).toEqual({
      kind: 'token_invalid',
      status: 401,
      message: 'Bad credentials',
    });
    expect(refusal(await readPullRequest(client, SHOP, 9))).toMatchObject({
      kind: 'not_found',
      status: 404,
    });
    permissions({ pull_requests: 'read' });
    const pull = { head: 't/1-cart', base: 'main', title: 'x', body: '' };
    expect(refusal(await openPullRequest(client, SHOP, pull))).toEqual({
      kind: 'permission_missing',
      status: 403,
      message: 'Resource not accessible by personal access token',
      permissions: ['pull_requests=write'],
    });
    for (const result of [
      await updatePullRequest(client, SHOP, 1, { title: 'y' }),
      await closePullRequest(client, SHOP, 1),
      await reopenPullRequest(client, SHOP, 1),
    ]) {
      expect(refusal(result)).toMatchObject({
        kind: 'permission_missing',
        permissions: ['pull_requests=write'],
      });
    }
    permissions({ pull_requests: undefined });
    for (const result of [
      await findPullRequests(client, SHOP, 't/1-cart'),
      await isPullRequestMerged(client, SHOP, 1),
    ]) {
      expect(refusal(result)).toMatchObject({
        kind: 'permission_missing',
        permissions: ['pull_requests=read'],
      });
    }
  });

  it('say so when GitHub answers with a body it does not document', async () => {
    github.override = () => ({ status: 200, body: { number: 'one' } });
    expect(refusal(await readPullRequest(client, SHOP, 1))).toEqual({
      kind: 'unexpected',
      status: 200,
      message: 'The answer is not what GitHub documents',
    });
  });
});

describe('reviews', () => {
  it('are posted as comments; approval and request changes are refused on your own', async () => {
    const { head } = await openCart();
    expect(
      value(await postReview(client, SHOP, 1, { event: 'COMMENT', body: 'Looks right' })),
    ).toMatchObject({ state: 'COMMENTED' });
    expect(github.pullRequest(repo, 1).reviews).toMatchObject([
      { body: 'Looks right', state: 'COMMENTED', commitId: head },
    ]);
    expect(refusal(await postReview(client, SHOP, 1, { event: 'APPROVE', body: 'Yes' }))).toEqual({
      kind: 'invalid',
      status: 422,
      message: 'Unprocessable Entity: Review Can not approve your own pull request',
      details: ['Review Can not approve your own pull request'],
    });
    expect(
      refusal(await postReview(client, SHOP, 1, { event: 'REQUEST_CHANGES', body: 'Fix it' })),
    ).toMatchObject({
      kind: 'invalid',
      details: ['Review Can not request changes on your own pull request'],
    });
  });

  it('are refused without Pull requests write, or on a pull request that does not exist', async () => {
    await openCart();
    expect(refusal(await postReview(client, SHOP, 7, { event: 'COMMENT', body: 'x' })).kind).toBe(
      'not_found',
    );
    permissions({ pull_requests: 'read' });
    expect(
      refusal(await postReview(client, SHOP, 1, { event: 'COMMENT', body: 'x' })),
    ).toMatchObject({ kind: 'permission_missing', permissions: ['pull_requests=write'] });
  });
});

describe('branches', () => {
  it('are deleted, and a branch already gone is accepted', async () => {
    branchWith('t/1-cart', { 'cart.md': 'Cart\n' });
    expect(value(await deleteBranch(client, SHOP, 't/1-cart'))).toBe('deleted');
    expect(github.branches(repo).has('t/1-cart')).toBe(false);
    expect(value(await deleteBranch(client, SHOP, 't/1-cart'))).toBe('already_gone');
  });

  it('are not deleted without Contents write', async () => {
    branchWith('t/1-cart', { 'cart.md': 'Cart\n' });
    permissions({ contents: 'read' });
    expect(refusal(await deleteBranch(client, SHOP, 't/1-cart'))).toMatchObject({
      kind: 'permission_missing',
      permissions: ['contents=write'],
    });
    expect(github.branches(repo).has('t/1-cart')).toBe(true);
  });
});

describe('CI', () => {
  it("lists a head commit's pull_request runs, with their jobs and steps", async () => {
    const { head } = await openCart();
    const runs = value(await listCommitRuns(client, SHOP, head));
    expect(runs).toMatchObject([
      {
        name: 'CI',
        event: 'pull_request',
        status: 'queued',
        conclusion: null,
        headSha: head,
        headBranch: 't/1-cart',
        pullRequests: [1],
      },
    ]);
    expect(value(await listCommitRuns(client, SHOP, head, 'push'))).toEqual([]);
    const [run] = github.runs(repo, head);
    if (!run) throw new Error('no run');
    github.startRun(run);
    const jobs = value(await listRunJobs(client, SHOP, runs[0]?.id ?? 0));
    expect(jobs.map((job) => [job.name, job.status])).toEqual([
      ['docs-links', 'in_progress'],
      ['ci', 'in_progress'],
    ]);
    expect(jobs[0]?.steps[0]).toEqual({
      name: 'Set up job',
      number: 1,
      status: 'in_progress',
      conclusion: null,
    });
  });

  it("reads the end of a failed job's log through the redirect, without the token", async () => {
    const { head } = await openCart();
    const [run] = github.runs(repo, head);
    if (!run) throw new Error('no run');
    const docsLinks = run.jobs[0]?.id ?? 0;
    // A job not finished yet has no log (A14).
    expect(refusal(await readJobLogEnd(client, SHOP, docsLinks, 4000))).toMatchObject({
      kind: 'not_found',
      status: 404,
    });

    github.completeRun(run, [
      {
        job: 'docs-links',
        step: 'Check documentation links',
        log: 'README.md\n  1:5  warning  Link to unknown file: `docs/user/faq.md`',
      },
    ]);
    const [completed] = value(await listCommitRuns(client, SHOP, head));
    expect(completed).toMatchObject({ status: 'completed', conclusion: 'failure' });
    const failed = value(await listRunJobs(client, SHOP, completed?.id ?? 0)).find(
      (job) => job.conclusion === 'failure',
    );
    expect(failed?.steps.map((step) => [step.name, step.conclusion])).toEqual([
      ['Set up job', 'success'],
      ['Run actions/checkout@v7.0.1', 'success'],
      ['Run actions/setup-node@v7.0.0', 'success'],
      ['Check documentation links', 'failure'],
      ['Complete job', 'skipped'],
    ]);

    const log = value(await readJobLogEnd(client, SHOP, failed?.id ?? 0, 4000));
    expect(log.truncated).toBe(false);
    expect(log.text).toContain('Link to unknown file: `docs/user/faq.md`');
    expect(log.text).toMatch(/##\[error\]Process completed with exit code 1\.\n$/);
    const end = value(await readJobLogEnd(client, SHOP, failed?.id ?? 0, 60));
    expect(end).toEqual({ text: log.text.slice(-60), truncated: true });
    expect(github.logRequests).toHaveLength(2);
    expect(github.logRequests.map((request) => request.authorization)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('reads the combined commit status: pending with no statuses, then each context', async () => {
    const { head } = await openCart();
    expect(value(await readCommitStatus(client, SHOP, head))).toEqual({
      state: 'pending',
      sha: head,
      statuses: [],
    });
    github.setStatus(repo, head, { context: 'deploy', state: 'success', description: 'Ready' });
    expect(value(await readCommitStatus(client, SHOP, 't/1-cart'))).toEqual({
      state: 'success',
      sha: head,
      statuses: [{ context: 'deploy', state: 'success', description: 'Ready', targetUrl: null }],
    });
    expect(refusal(await readCommitStatus(client, SHOP, 'no-such-branch')).kind).toBe('not_found');
  });

  it('returns the refusals of a token without Actions or Commit statuses read', async () => {
    const { head } = await openCart();
    const [run] = github.runs(repo, head);
    permissions({ actions: undefined, statuses: undefined });
    for (const result of [
      await listCommitRuns(client, SHOP, head),
      await listRunJobs(client, SHOP, run?.id ?? 0),
      await readJobLogEnd(client, SHOP, run?.jobs[0]?.id ?? 0, 100),
    ]) {
      expect(refusal(result)).toMatchObject({
        kind: 'permission_missing',
        permissions: ['actions=read'],
      });
    }
    expect(refusal(await readCommitStatus(client, SHOP, head))).toMatchObject({
      kind: 'permission_missing',
      permissions: ['statuses=read'],
    });
    expect(github.logRequests).toEqual([]);
  });
});

it('throws GitHubUnreachableError when GitHub does not answer', async () => {
  const away = clientWith(TOKEN, 'http://127.0.0.1:9');
  await expect(readPullRequest(away, SHOP, 1)).rejects.toBeInstanceOf(GitHubUnreachableError);
  await expect(readJobLogEnd(away, SHOP, 1, 100)).rejects.toBeInstanceOf(GitHubUnreachableError);
});
