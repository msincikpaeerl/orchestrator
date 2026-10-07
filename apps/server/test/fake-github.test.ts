import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { createTestHome, linkSystemTool, type TestHome } from '@orchestrator/daemon/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { takeRealGitHubAttempts } from '@orchestrator/daemon/testing/real-github-guard';
import { githubControl } from './fake-github-controls.js';
import { documentedBody, shapeProblems, shaped } from './fake-github/documented.js';
import {
  fullAccount,
  skeletonWorkflow,
  startFakeGitHub,
  type FakeAccount,
  type FakeGitHub,
  type FakeRepository,
} from './fake-github.js';
import { createOwner, startTestApp } from './helpers.js';

// The fake GitHub itself (lot 3 plan, step C): Git over HTTP and the REST API on the same
// repositories, with the same tokens. Later steps rely on these behaviours; the ones GitHub's
// documentation does not state are checked on the real GitHub by step E's smoke script.

const TOKEN = 'github_pat_fake_test_0123456789';
const OTHER = 'github_pat_fake_other_0123456789';
const exec = promisify(execFile);

let github: FakeGitHub;
let home: TestHome;
let account: FakeAccount;
let repo: FakeRepository;
let work: string;

beforeEach(async () => {
  github = await startFakeGitHub();
  repo = { name: 'shop', private: true, workflows: [skeletonWorkflow()] };
  account = fullAccount({ repositories: [repo, { name: 'site', private: false }] });
  github.accounts.set(TOKEN, account);
  home = await createTestHome();
  await linkSystemTool(home.bin, 'git');
  work = join(home.root, 'work');
});

afterEach(async () => {
  await github.close();
  await home.remove();
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec(join(home.bin, 'git'), args, {
    cwd,
    env: {
      ...home.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Agent',
      GIT_AUTHOR_EMAIL: 'agent@example.com',
      GIT_COMMITTER_NAME: 'Agent',
      GIT_COMMITTER_EMAIL: 'agent@example.com',
    },
  });
  return stdout.trim();
}

/** Resolves with Git's error output; fails the test when the command succeeds. */
async function gitFails(cwd: string, ...args: string[]): Promise<string> {
  return git(cwd, ...args).then(
    () => {
      throw new Error(`git ${args.join(' ')} succeeded`);
    },
    (error: unknown) => (error as { stderr: string }).stderr,
  );
}

/** The clone URL, with a token as the password of HTTP Basic authentication when given. */
function cloneUrl(token?: string, name = 'shop'): string {
  const url = new URL(`${github.url}/octo-owner/${name}.git`);
  if (token !== undefined) {
    url.username = 'x-access-token';
    url.password = token;
  }
  return url.toString();
}

async function cloneWithToken(): Promise<void> {
  await mkdir(work, { recursive: true });
  await git(home.root, 'clone', '--quiet', cloneUrl(TOKEN), work);
}

/** A commit of `files` on `branch` (created from the current commit when new), pushed. */
async function pushCommit(branch: string, files: Record<string, string>, message = 'Work') {
  const branches = await git(work, 'branch', '--list', branch);
  if (branches === '') await git(work, 'checkout', '--quiet', '-b', branch);
  else await git(work, 'checkout', '--quiet', branch);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(work, path, '..'), { recursive: true });
    await writeFile(join(work, path), content);
  }
  await git(work, 'add', '-A');
  await git(work, 'commit', '--quiet', '-m', message);
  await git(work, 'push', '--quiet', 'origin', `refs/heads/${branch}:refs/heads/${branch}`);
  return git(work, 'rev-parse', 'HEAD');
}

interface Reply {
  status: number;
  headers: Headers;
  body: unknown;
}

async function api(method: string, path: string, body?: unknown, token = TOKEN): Promise<Reply> {
  const response = await fetch(`${github.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2026-03-10',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text === '' ? null : (JSON.parse(text) as unknown),
  };
}

type JsonObject = Record<string, unknown>;

function json(reply: Reply): JsonObject {
  return reply.body as JsonObject;
}

const REPO = '/repos/octo-owner/shop';

async function openPull(head: string, title = `${head}: work`): Promise<JsonObject> {
  const reply = await api('POST', `${REPO}/pulls`, { title, head, base: 'main', body: 'Report' });
  expect(reply.status, JSON.stringify(reply.body)).toBe(201);
  return json(reply);
}

/** GitHub computes mergeability in the background: read until it is known. */
async function mergeable(number: number): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const value = json(await api('GET', `${REPO}/pulls/${String(number)}`)).mergeable;
    if (typeof value === 'boolean') return value;
  }
  throw new Error('mergeable never computed');
}

describe('Git over HTTP', () => {
  it('accepts a push with the token, and the REST API sees it', async () => {
    await cloneWithToken();
    const sha = await pushCommit('t/1-cart', { 'cart.md': 'Cart\n' });

    const ref = await api('GET', `${REPO}/git/ref/heads/t/1-cart`);
    expect(ref.status).toBe(200);
    expect(json(ref).object).toMatchObject({ sha, type: 'commit' });
    const commit = json(await api('GET', `${REPO}/git/commits/${sha}`));
    expect(commit.message).toBe('Work');
    expect(github.gitRequests.at(-1)).toMatchObject({ access: 'push', outcome: 'served' });
  });

  it('refuses a push without a credential, with a wrong token or without Contents write', async () => {
    await cloneWithToken();
    await git(work, 'remote', 'set-url', 'origin', cloneUrl());
    await writeFile(join(work, 'a.md'), 'A\n');
    await git(work, 'add', '-A');
    await git(work, 'commit', '--quiet', '-m', 'A');
    const push = ['push', 'origin', 'HEAD:refs/heads/t/2-a'];

    // No credential: GitHub asks for one, and Git cannot prompt.
    expect(await gitFails(work, ...push)).toMatch(
      /could not read Username|terminal prompts disabled/,
    );
    expect(github.gitRequests.at(-1)).toMatchObject({ credentialSent: false, outcome: 401 });

    await git(work, 'remote', 'set-url', 'origin', cloneUrl('github_pat_unknown_0000'));
    expect(await gitFails(work, ...push)).toMatch(/Authentication failed/);
    expect(github.gitRequests.at(-1)).toMatchObject({ credentialSent: true, outcome: 401 });

    github.accounts.set(OTHER, {
      ...account,
      permissions: { ...account.permissions, contents: 'read' },
    });
    await git(work, 'remote', 'set-url', 'origin', cloneUrl(OTHER));
    expect(await gitFails(work, ...push)).toMatch(/403/);
    expect(github.gitRequests.at(-1)).toMatchObject({ access: 'push', outcome: 403 });
    // The token can still fetch.
    await git(work, 'fetch', '--quiet', 'origin');

    expect(github.branches(repo).has('t/2-a')).toBe(false);
  });

  it('fetches a public repository without a credential, never a private one', async () => {
    await git(home.root, 'clone', '--quiet', cloneUrl(undefined, 'site'), join(home.root, 'site'));
    expect(await gitFails(home.root, 'clone', cloneUrl(), join(home.root, 'private'))).toMatch(
      /could not read Username|terminal prompts disabled/,
    );
  });

  it('refuses a push changing a workflow without the Workflows permission', async () => {
    github.accounts.set(OTHER, {
      ...account,
      permissions: { ...account.permissions, workflows: 'read' },
    });
    await cloneWithToken();
    await git(work, 'remote', 'set-url', 'origin', cloneUrl(OTHER));
    await git(work, 'checkout', '--quiet', '-b', 't/3-ci');
    await mkdir(join(work, '.github', 'workflows'), { recursive: true });
    await writeFile(join(work, '.github', 'workflows', 'ci.yml'), 'name: CI\n');
    await git(work, 'add', '-A');
    await git(work, 'commit', '--quiet', '-m', 'CI');
    const refused = await gitFails(work, 'push', 'origin', 'HEAD:refs/heads/t/3-ci');
    expect(refused).toContain(
      'refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflows` permission',
    );
    expect(github.branches(repo).has('t/3-ci')).toBe(false);

    // Other files go through.
    await git(work, 'reset', '--quiet', '--hard', 'origin/main');
    await writeFile(join(work, 'b.md'), 'B\n');
    await git(work, 'add', '-A');
    await git(work, 'commit', '--quiet', '-m', 'B');
    await git(work, 'push', '--quiet', 'origin', 'HEAD:refs/heads/t/3-ci');
    expect(github.branches(repo).has('t/3-ci')).toBe(true);
  });

  it('serves commits the REST API made', async () => {
    const put = await api('PUT', `${REPO}/contents/docs/a.md`, {
      message: 'Add a',
      content: Buffer.from('A\n').toString('base64'),
    });
    expect(put.status).toBe(201);
    await cloneWithToken();
    expect(readFileSync(join(work, 'docs', 'a.md'), 'utf8')).toBe('A\n');
  });
});

describe('pull requests', () => {
  it('are opened, read, listed, updated, closed, reopened and merged', async () => {
    await cloneWithToken();
    const head = await pushCommit('t/1-cart', { 'cart.md': 'Cart\n' });
    const opened = await openPull('t/1-cart');
    expect(opened).toMatchObject({
      number: 1,
      state: 'open',
      title: 't/1-cart: work',
      body: 'Report',
      draft: false,
      merged: false,
      user: { login: 'octo-owner' },
      head: { ref: 't/1-cart', sha: head },
      base: { ref: 'main' },
    });
    expect(String(opened.html_url)).toBe(`${github.url}/octo-owner/shop/pull/1`);
    // Computed in the background: unknown first, then known.
    expect(opened.mergeable).toBeNull();
    expect(json(await api('GET', `${REPO}/pulls/1`)).mergeable).toBe(true);

    const listed = await api('GET', `${REPO}/pulls?head=octo-owner:t/1-cart&state=all`);
    expect((listed.body as JsonObject[]).map((pull) => pull.number)).toEqual([1]);
    expect(
      ((await api('GET', `${REPO}/pulls?head=octo-owner:t/9-none&state=all`)).body as unknown[])
        .length,
    ).toBe(0);
    // One open pull request per head and base.
    const again = await api('POST', `${REPO}/pulls`, {
      title: 'x',
      head: 't/1-cart',
      base: 'main',
    });
    expect(again.status).toBe(422);

    const updated = await api('PATCH', `${REPO}/pulls/1`, { body: 'Report, second submission' });
    expect(updated.status).toBe(200);
    expect(json(updated).body).toBe('Report, second submission');

    expect(json(await api('PATCH', `${REPO}/pulls/1`, { state: 'closed' }))).toMatchObject({
      state: 'closed',
      merged: false,
    });
    expect((await api('GET', `${REPO}/pulls?state=open`)).body).toEqual([]);
    expect(json(await api('PATCH', `${REPO}/pulls/1`, { state: 'open' })).state).toBe('open');
    expect((await api('GET', `${REPO}/pulls/1/merge`)).status).toBe(404);

    const merge = github.mergePullRequest(repo, 1, 'squash');
    const merged = json(await api('GET', `${REPO}/pulls/1`));
    expect(merged).toMatchObject({ state: 'closed', merged: true });
    // Removed from pull requests in REST API version 2026-03-10.
    expect(merged).not.toHaveProperty('merge_commit_sha');
    expect(merged.merged_at).toEqual(expect.any(String));
    expect((await api('GET', `${REPO}/pulls/1/merge`)).status).toBe(204);
    // Squashed: one commit on main holding the change, whose parent is the old main.
    const main = json(await api('GET', `${REPO}/git/commits/${merge}`));
    expect(main.message).toBe('t/1-cart: work (#1)');
    expect(main.parents).toHaveLength(1);
    expect(github.branches(repo).get('main')).toBe(merge);
    // A merged pull request cannot be reopened.
    expect((await api('PATCH', `${REPO}/pulls/1`, { state: 'open' })).status).toBe(422);
  });

  it('refuse a head that does not exist or has no commits', async () => {
    expect(
      (await api('POST', `${REPO}/pulls`, { title: 'x', head: 'nope', base: 'main' })).status,
    ).toBe(422);
    expect(
      (await api('POST', `${REPO}/pulls`, { title: 'x', head: 'main', base: 'main' })).status,
    ).toBe(422);
    expect((await api('POST', `${REPO}/pulls`, {})).status).toBe(422);
  });

  it('closed by the owner on GitHub, stay closed', async () => {
    await cloneWithToken();
    await pushCommit('t/2-close', { 'b.md': 'B\n' });
    await openPull('t/2-close');
    github.closePullRequest(repo, 1);
    expect(json(await api('GET', `${REPO}/pulls/1`))).toMatchObject({
      state: 'closed',
      merged: false,
    });
    expect(() => github.mergePullRequest(repo, 1)).toThrow('is not open');
  });
});

describe("GitHub's documented shapes", () => {
  it('answer a new pull request with every documented field, nulls included', async () => {
    await cloneWithToken();
    await pushCommit('t/1-cart', { 'cart.md': 'Cart\n' });
    const body = await openPull('t/1-cart');
    expect(shapeProblems(documentedBody('POST /repos/{owner}/{repo}/pulls', 201), body)).toEqual(
      [],
    );
    // What a new pull request has no value for yet, as GitHub documents it.
    expect(body).toMatchObject({
      mergeable: null,
      merged: false,
      merged_at: null,
      closed_at: null,
      milestone: null,
      auto_merge: null,
      merged_by: null,
    });
    expect(body).not.toHaveProperty('merge_commit_sha');
    expect(body).not.toHaveProperty('assignee');
    const listed = (await api('GET', `${REPO}/pulls`)).body as Record<string, unknown>[];
    expect(listed[0]).not.toHaveProperty('mergeable');
  });

  it('refuse a field GitHub does not document, a missing one, and a null not documented', () => {
    const operation = 'POST /repos/{owner}/{repo}/pulls';
    expect(() => shaped(operation, 201, { number: 1, merge_commit_sha: null })).toThrow(
      /merge_commit_sha: not documented/,
    );
    const schema = documentedBody(operation, 201);
    const body = shaped(operation, 201, { number: 1 }) as Record<string, unknown>;
    expect(shapeProblems(schema, { ...body, number: undefined })).toContain('number: missing');
    expect(shapeProblems(schema, { ...body, number: null })).toContain(
      'number: null, not documented as nullable',
    );
    expect(shapeProblems(schema, { ...body, number: '1' })).toContain(
      'number: string, documented as integer',
    );
  });
});

describe('reviews', () => {
  it('refuse approval and request-changes on your own pull request, accept a comment', async () => {
    await cloneWithToken();
    await pushCommit('t/1-cart', { 'cart.md': 'Cart\n' });
    await openPull('t/1-cart');

    const approve = await api('POST', `${REPO}/pulls/1/reviews`, {
      event: 'APPROVE',
      body: 'Fine',
    });
    expect(approve.status).toBe(422);
    expect(json(approve).errors).toEqual(['Review Can not approve your own pull request']);
    const changes = await api('POST', `${REPO}/pulls/1/reviews`, {
      event: 'REQUEST_CHANGES',
      body: 'cart.md:1 needs a title',
    });
    expect(changes.status).toBe(422);
    expect(json(changes).errors).toEqual([
      'Review Can not request changes on your own pull request',
    ]);
    // A comment needs a body.
    expect((await api('POST', `${REPO}/pulls/1/reviews`, { event: 'COMMENT' })).status).toBe(422);

    const comment = await api('POST', `${REPO}/pulls/1/reviews`, {
      event: 'COMMENT',
      body: 'Approved by Quality.\n\n- cart.md:1 fine',
    });
    expect(comment.status).toBe(200);
    expect(json(comment)).toMatchObject({ state: 'COMMENTED', user: { login: 'octo-owner' } });
    const reviews = (await api('GET', `${REPO}/pulls/1/reviews`)).body as JsonObject[];
    expect(reviews.map((review) => review.state)).toEqual(['COMMENTED']);
  });
});

describe('Actions runs and commit statuses', () => {
  it('start runs for a pull request, scripted through queued, running and success', async () => {
    await cloneWithToken();
    const head = await pushCommit('t/1-cart', { 'cart.md': 'Cart\n' });
    // A push to a branch without a pull request starts nothing: the skeleton's CI runs on pull
    // requests and on pushes to the default branch.
    expect(github.runs(repo, head)).toEqual([]);
    await openPull('t/1-cart');

    const runsOf = async (sha: string) =>
      json(await api('GET', `${REPO}/actions/runs?head_sha=${sha}`)).workflow_runs as JsonObject[];
    expect(await runsOf(head)).toMatchObject([
      {
        name: 'CI',
        event: 'pull_request',
        head_sha: head,
        head_branch: 't/1-cart',
        status: 'queued',
        conclusion: null,
      },
    ]);
    const [run] = github.runs(repo, head);
    if (!run) throw new Error('no run');
    github.startRun(run);
    expect((await runsOf(head))[0]).toMatchObject({ status: 'in_progress', conclusion: null });
    const jobs = json(await api('GET', `${REPO}/actions/runs/${String(run.id)}/jobs`))
      .jobs as JsonObject[];
    expect(jobs.map((job) => [job.name, job.status])).toEqual([
      ['docs-links', 'in_progress'],
      ['ci', 'in_progress'],
    ]);
    github.completeRun(run);
    expect((await runsOf(head))[0]).toMatchObject({ status: 'completed', conclusion: 'success' });

    // A new push to the head: a run for the new commit only.
    const second = await pushCommit('t/1-cart', { 'cart.md': 'Cart, v2\n' });
    expect((await runsOf(second)).map((found) => found.status)).toEqual(['queued']);
    expect(await runsOf(head)).toHaveLength(1);
  });

  it('give a failed job its steps and its log through a redirect to another host', async () => {
    repo.ci = {
      failures: [
        {
          job: 'docs-links',
          step: 'Check documentation links',
          log: 'README.md\n  1:5  warning  Link to unknown file: `docs/user/faq.md`',
        },
      ],
    };
    await cloneWithToken();
    const head = await pushCommit('t/1-faq', { 'README.md': 'See [FAQ](docs/user/faq.md).\n' });
    await openPull('t/1-faq');
    const [run] = json(await api('GET', `${REPO}/actions/runs?head_sha=${head}`))
      .workflow_runs as JsonObject[];
    expect(run).toMatchObject({ status: 'completed', conclusion: 'failure' });
    const jobs = json(await api('GET', `${REPO}/actions/runs/${String(run?.id)}/jobs`))
      .jobs as JsonObject[];
    const failed = jobs.find((job) => job.conclusion === 'failure');
    expect(failed?.name).toBe('docs-links');
    expect(failed?.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Check documentation links', conclusion: 'failure' }),
        expect.objectContaining({
          name: 'Post Run actions/setup-node@v7.0.0',
          conclusion: 'skipped',
        }),
        expect.objectContaining({
          name: 'Post Run actions/checkout@v7.0.1',
          conclusion: 'success',
        }),
        expect.objectContaining({ name: 'Complete job', conclusion: 'success' }),
      ]),
    );

    const logs = await api('GET', `${REPO}/actions/jobs/${String(failed?.id)}/logs`);
    expect(logs.status).toBe(302);
    const location = new URL(logs.headers.get('location') ?? '');
    expect(location.origin).not.toBe(new URL(github.url).origin);
    // What a client does: follow the redirect (fetch drops the Authorization header on the way).
    const followed = await fetch(`${github.url}${REPO}/actions/jobs/${String(failed?.id)}/logs`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const text = await followed.text();
    expect(text).toContain('Link to unknown file: `docs/user/faq.md`');
    expect(text).toMatch(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z ##\[error\]Process completed with exit code 1\.$/m,
    );
    // GitHub's shape (test/fixtures/github-job-log/): every line stamped, the post step's
    // clean-up after the failure in the same second, the log ending with Complete job.
    const lines = text.trimEnd().split('\n');
    expect(lines.every((line) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z /.test(line))).toBe(true);
    const error = lines.findIndex((line) => line.includes('##[error]'));
    expect(lines[error + 1]).toMatch(/Z Post job cleanup\.$/);
    expect(lines[error + 1]?.slice(0, 19)).toBe(lines[error]?.slice(0, 19));
    expect(lines.at(-1)).toMatch(/Z Cleaning up orphan processes$/);
    const steps = (failed?.steps ?? []) as JsonObject[];
    const check = steps.find((step) => step.name === 'Check documentation links');
    expect(check?.started_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(check?.completed_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  it('start no run when Actions never starts, and none while the pull request has a conflict', async () => {
    repo.ci = 'none';
    await cloneWithToken();
    const head = await pushCommit('t/1-none', { 'a.md': 'A\n' });
    await openPull('t/1-none');
    expect(json(await api('GET', `${REPO}/actions/runs?head_sha=${head}`)).total_count).toBe(0);

    repo.ci = 'queued';
    github.commit(repo, 'main', { 'b.md': 'Base\n' }, 'Base change');
    await git(work, 'checkout', '--quiet', 'main');
    const conflicting = await pushCommit('t/2-conflict', { 'b.md': 'Branch\n' });
    await openPull('t/2-conflict');
    expect(await mergeable(2)).toBe(false);
    expect(json(await api('GET', `${REPO}/pulls/2`)).mergeable_state).toBe('dirty');
    expect(github.runs(repo, conflicting)).toEqual([]);
  });

  it('run on a push to the default branch, after a merge', async () => {
    repo.ci = 'success';
    await cloneWithToken();
    await pushCommit('t/1-cart', { 'cart.md': 'Cart\n' });
    await openPull('t/1-cart');
    const merge = github.mergePullRequest(repo, 1);
    expect(github.runs(repo, merge).map((run) => [run.event, run.conclusion])).toEqual([
      ['push', 'success'],
    ]);
  });

  it('combine commit statuses as GitHub documents', async () => {
    const main = github.branches(repo).get('main') ?? '';
    const status = async () => json(await api('GET', `${REPO}/commits/main/status`));
    expect(await status()).toMatchObject({ state: 'pending', total_count: 0, sha: main });
    github.setStatus(repo, 'main', { context: 'deploy', state: 'pending' });
    github.setStatus(repo, 'main', { context: 'lint', state: 'success' });
    expect((await status()).state).toBe('pending');
    github.setStatus(repo, 'main', { context: 'deploy', state: 'success' });
    expect(await status()).toMatchObject({ state: 'success', total_count: 2 });
    github.setStatus(repo, main, { context: 'lint', state: 'error' });
    expect((await status()).state).toBe('failure');
    const list = (await api('GET', `${REPO}/commits/${main}/statuses`)).body as JsonObject[];
    expect(list.map((entry) => `${String(entry.context)}:${String(entry.state)}`)).toEqual([
      'lint:error',
      'deploy:success',
      'lint:success',
      'deploy:pending',
    ]);
    expect((await api('GET', `${REPO}/commits/nope/status`)).status).toBe(404);
  });
});

describe('the owner on GitHub', () => {
  it('makes a conflict with a commit on the base branch; Update branch merges a clean one', async () => {
    await cloneWithToken();
    const head = await pushCommit('t/1-cart', { 'cart.md': 'Cart\n' });
    await openPull('t/1-cart');
    expect(await mergeable(1)).toBe(true);

    // Another file changed on main: still mergeable, the branch is behind.
    github.commit(repo, 'main', { 'other.md': 'Other\n' }, 'Other change');
    expect(json(await api('GET', `${REPO}/pulls/1`)).mergeable).toBeNull();
    expect(await mergeable(1)).toBe(true);
    const runsBefore = github.runs(repo).length;
    const updated = github.updatePullRequestBranch(repo, 1);
    const pull = json(await api('GET', `${REPO}/pulls/1`));
    expect(pull.head).toMatchObject({ sha: updated });
    const commit = json(await api('GET', `${REPO}/git/commits/${updated}`));
    expect(commit.message).toBe("Merge branch 'main' into t/1-cart");
    expect((commit.parents as JsonObject[]).map((parent) => parent.sha)[0]).toBe(head);
    // The pull request's head moved: `synchronize` starts its CI again.
    expect(github.runs(repo).length).toBe(runsBefore + 1);
    // The local branch is behind GitHub's and fast-forwards to it.
    await git(work, 'fetch', '--quiet', 'origin');
    expect(await git(work, 'merge-base', '--is-ancestor', head, 'origin/t/1-cart')).toBe('');

    // The same file changed on main: a conflict, which Update branch and merging refuse.
    github.commit(repo, 'main', { 'cart.md': 'Another cart\n' }, 'Conflicting change');
    expect(await mergeable(1)).toBe(false);
    expect(() => github.updatePullRequestBranch(repo, 1)).toThrow('conflicts');
    expect(() => github.mergePullRequest(repo, 1)).toThrow('conflicts');
  });
});

describe('refusals', () => {
  it('answer 401 to a token GitHub does not know', async () => {
    const reply = await api('GET', `${REPO}/pulls`, undefined, 'github_pat_unknown_0000');
    expect(reply.status).toBe(401);
    expect(json(reply).message).toBe('Bad credentials');
  });

  it('answer 403 naming the missing permission', async () => {
    github.accounts.set(OTHER, {
      ...account,
      permissions: { metadata: 'read', contents: 'read' },
    });
    const create = await api(
      'POST',
      `${REPO}/pulls`,
      { title: 'x', head: 'a', base: 'main' },
      OTHER,
    );
    expect(create.status).toBe(403);
    expect(json(create).message).toBe('Resource not accessible by personal access token');
    expect(create.headers.get('x-accepted-github-permissions')).toBe('pull_requests=write');
    const runs = await api('GET', `${REPO}/actions/runs`, undefined, OTHER);
    expect(runs.headers.get('x-accepted-github-permissions')).toBe('actions=read');
    const status = await api('GET', `${REPO}/commits/main/status`, undefined, OTHER);
    expect(status.headers.get('x-accepted-github-permissions')).toBe('statuses=read');
    const reviews = await api(
      'POST',
      `${REPO}/pulls/1/reviews`,
      { event: 'COMMENT', body: 'x' },
      OTHER,
    );
    expect(reviews.headers.get('x-accepted-github-permissions')).toBe('pull_requests=write');
    // Reading one pull request takes Pull requests or Contents: here Contents is enough.
    expect((await api('GET', `${REPO}/pulls/1`, undefined, OTHER)).status).toBe(404);
    github.accounts.set(OTHER, { ...account, permissions: { metadata: 'read' } });
    const read = await api('GET', `${REPO}/pulls/1`, undefined, OTHER);
    expect(read.status).toBe(403);
    expect(read.headers.get('x-accepted-github-permissions')).toBe(
      'pull_requests=read; contents=read',
    );
  });
});

describe('the end-to-end server controls', () => {
  it('play CI, a merge and a refusal through the same functions', async () => {
    await cloneWithToken();
    await pushCommit('t/1-cart', { 'cart.md': 'Cart\n' });
    await openPull('t/1-cart');
    expect(
      githubControl(github, '/github/ci', { repository: 'shop', ref: 't/1-cart', action: 'start' }),
    ).toEqual({ status: 200, body: { runs: 1 } });
    githubControl(github, '/github/ci', {
      repository: 'shop',
      ref: 't/1-cart',
      action: 'complete',
      failures: [{ job: 'docs-links', step: 'Check documentation links', log: 'broken' }],
    });
    expect(github.runs(repo, 't/1-cart')[0]?.conclusion).toBe('failure');
    githubControl(github, '/github/commit', {
      repository: 'shop',
      branch: 'main',
      files: { 'cart.md': 'Conflict\n' },
      message: 'Conflict',
    });
    expect(githubControl(github, '/github/merge', { repository: 'shop', pullRequest: 1 })).toEqual({
      status: 409,
      body: { message: 'pull request #1 has conflicts with main' },
    });
    expect(githubControl(github, '/github/close', { repository: 'shop', pullRequest: 1 })).toBe(
      204,
    );
  });
});

describe('the real GitHub', () => {
  it('is never reached: a server left on its default GitHub address fails the test', async () => {
    // As a test that forgot `githubApiUrl` would: the server's client calls api.github.com.
    const t = await startTestApp();
    try {
      const cookie = await createOwner(t.app);
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/github/token/inspect',
        headers: { cookie },
        payload: { token: TOKEN },
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      // vitest.setup.ts fails the test after it with these; taken here to check them.
      expect(takeRealGitHubAttempts()).toEqual(['GET https://api.github.com/user']);
    } finally {
      await t.close();
    }
  });
});

describe('the fake leaves nothing behind', () => {
  it('keeps its repositories in a test folder and removes it, with no Git process left', async () => {
    await cloneWithToken();
    await pushCommit('t/1-cart', { 'cart.md': 'Cart\n' });
    const root = github.root;
    expect(basename(root)).toMatch(/^od-test-github-/);
    expect(root.startsWith(tmpdir())).toBe(true);
    expect(existsSync(root)).toBe(true);
    await github.close();
    expect(existsSync(root)).toBe(false);
    // No process (the Git backend, a hook) still works in it.
    const left = readdirSync('/proc').filter((pid) => {
      if (!/^\d+$/.test(pid)) return false;
      try {
        return readFileSync(`/proc/${pid}/environ`, 'utf8').includes(root);
      } catch {
        return false;
      }
    });
    expect(left).toEqual([]);
    // For afterEach, which closes the fake of each test.
    github = await startFakeGitHub();
  });
});
