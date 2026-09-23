import { GitHubStatusResponse } from '@orchestrator/protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GitHubClient } from '../src/github/client.js';
import { storedTokenClient } from '../src/github/connection.js';
import {
  GitHubOperationError,
  REQUIRED_CHECK,
  RULESET_NAME,
  applyBranchProtection,
  applySkeleton,
  createRepository,
  findMissingHarness,
  findRepository,
  listOwnerRepositories,
} from '../src/github/repositories.js';
import { renderSkeleton, type SkeletonFile } from '../src/github/skeleton.js';
import { deriveSecretKey } from '../src/secrets.js';
import { defaultSettings } from '../src/settings.js';
import {
  fullAccount,
  repositoryFiles,
  repositoryHistory,
  startFakeGitHub,
  type FakeAccount,
  type FakeGitHub,
  type FakeRepository,
} from './fake-github.js';
import { TEST_SECRET_KEY, createOwner, startTestApp, type TestApp } from './helpers.js';

const TOKEN = 'github_pat_11AAAAAAA0secretTokenValue1234567890';

let github: FakeGitHub;
let t: TestApp;
let cookie: string;
let account: FakeAccount;
let client: GitHubClient;

beforeAll(async () => {
  github = await startFakeGitHub();
});

afterAll(async () => {
  await github.close();
});

/** Saves a token for `account` through the API, then builds the stored-token client. */
async function connect(overrides: Partial<FakeAccount> = {}) {
  account = fullAccount(overrides);
  github.accounts.set(TOKEN, account);
  const saved = await t.app.inject({
    method: 'PUT',
    url: '/api/github/token',
    headers: { cookie },
    payload: { token: TOKEN, expiresOn: null },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const stored = await storedTokenClient({
    db: t.db,
    key: deriveSecretKey(TEST_SECRET_KEY),
    apiUrl: github.url,
    settings: defaultSettings,
  });
  if (!stored) throw new Error('no token');
  client = stored;
  github.requests.length = 0;
}

beforeEach(async () => {
  github.accounts.clear();
  github.requests.length = 0;
  github.override = undefined;
  t = await startTestApp({ githubApiUrl: github.url });
  cookie = await createOwner(t.app);
  await connect();
});

afterEach(async () => {
  await t.close();
});

function repository(name: string): FakeRepository {
  const found = account.repositories.find((repo) => repo.name === name);
  if (!found) throw new Error(`no repository ${name}`);
  return found;
}

async function problems() {
  const response = await t.app.inject({ method: 'GET', url: '/api/github', headers: { cookie } });
  const status = GitHubStatusResponse.parse(response.json());
  if (!status.connected) throw new Error('not connected');
  return status.problems;
}

async function skeleton(name: string, defaultBranch = 'main'): Promise<SkeletonFile[]> {
  return renderSkeleton({ name, description: 'A test project', defaultBranch, date: '2026-09-23' });
}

function requestsTo(method: string, pattern: RegExp) {
  return github.requests.filter(
    (request) => request.method === method && pattern.test(request.path),
  );
}

describe('creating a repository with the skeleton', () => {
  it.each([
    ['private', true],
    ['public', false],
  ])('a %s repository gets two commits: GitHub README, then the skeleton', async (_, isPrivate) => {
    const created = await createRepository(client, {
      name: 'shop',
      description: 'A test project',
      private: isPrivate,
    });
    expect(created).toEqual({
      owner: 'octo-owner',
      name: 'shop',
      private: isPrivate,
      archived: false,
      defaultBranch: 'main',
      createdAt: expect.any(String) as unknown,
    });
    expect(requestsTo('POST', /^\/user\/repos$/)[0]?.body).toEqual({
      name: 'shop',
      description: 'A test project',
      private: isPrivate,
      auto_init: true,
    });

    const files = await skeleton('shop');
    const result = await applySkeleton(client, created, files);
    expect(result.alreadyApplied).toBe(false);

    const history = repositoryHistory(repository('shop'));
    expect(history.map((commit) => commit.message)).toEqual([
      'chore: add the project skeleton',
      'Initial commit',
    ]);
    expect(history[0]?.sha).toBe(result.commit);
    expect(history[0]?.parents).toEqual([history[1]?.sha]);
    expect(repositoryFiles(repository('shop'))).toEqual(
      Object.fromEntries(files.map((file) => [file.path, file.content])),
    );

    // The branch moved forward without force.
    const moves = requestsTo('PATCH', /\/git\/refs\/heads\/main$/);
    expect(moves).toHaveLength(1);
    expect(moves[0]?.body).toEqual({ sha: result.commit, force: false });
  });

  it("uses the default branch from GitHub's answer", async () => {
    await connect({ defaultBranch: 'trunk' });
    const created = await createRepository(client, {
      name: 'shop',
      description: '',
      private: true,
    });
    expect(created.defaultBranch).toBe('trunk');
    const files = await skeleton('shop', created.defaultBranch);
    await applySkeleton(client, created, files);
    expect(repositoryHistory(repository('shop'))).toHaveLength(2);
    expect(repositoryFiles(repository('shop'))['.github/workflows/ci.yml']).toContain(
      "branches: ['trunk']",
    );
  });

  it('starts an empty repository with the README through the contents API', async () => {
    await connect({ repositories: [{ name: 'blank', private: true, empty: true }] });
    const files = await skeleton('blank');
    await applySkeleton(
      client,
      { owner: 'octo-owner', name: 'blank', defaultBranch: 'main' },
      files,
    );

    const put = requestsTo('PUT', /\/contents\/README\.md$/);
    expect(put).toHaveLength(1);
    const history = repositoryHistory(repository('blank'));
    expect(history.map((commit) => commit.message)).toEqual([
      'chore: add the project skeleton',
      'Initial commit',
    ]);
    expect(repositoryFiles(repository('blank'))['README.md']).toBe(
      files.find((file) => file.path === 'README.md')?.content,
    );
    expect(requestsTo('PATCH', /\/git\/refs\//)[0]?.body).toMatchObject({ force: false });
  });

  it('can be tried again after a failed skeleton step, still with two commits', async () => {
    await connect({ permissions: { ...fullAccount().permissions, workflows: 'read' } });
    const created = await createRepository(client, {
      name: 'shop',
      description: '',
      private: true,
    });
    const files = await skeleton('shop');

    // The skeleton contains a workflow: moving the branch needs Workflows.
    const failure = await applySkeleton(client, created, files).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GitHubOperationError);
    expect((failure as Error).message).toBe(
      'Could not move the branch main to the skeleton commit: the GitHub token is missing a permission (workflows=write)',
    );
    expect(repositoryHistory(repository('shop'))).toHaveLength(1);
    expect(await problems()).toContainEqual(
      expect.objectContaining({ type: 'permission_refused', permissions: ['workflows=write'] }),
    );

    // The owner fixes the token and tries again.
    account.permissions.workflows = 'write';
    const retried = await applySkeleton(client, created, files);
    expect(retried.alreadyApplied).toBe(false);
    expect(repositoryHistory(repository('shop')).map((commit) => commit.message)).toEqual([
      'chore: add the project skeleton',
      'Initial commit',
    ]);

    // Trying once more (for example after a restart lost the result) commits nothing.
    const again = await applySkeleton(client, created, files);
    expect(again).toEqual({ commit: retried.commit, alreadyApplied: true });
    expect(repositoryHistory(repository('shop'))).toHaveLength(2);
  });

  it('never forces the branch when someone pushed in the meantime', async () => {
    const created = await createRepository(client, {
      name: 'shop',
      description: '',
      private: true,
    });
    github.override = (request) => {
      if (request.method !== 'PATCH') return undefined;
      return { status: 422, body: { message: 'Update is not a fast forward' } };
    };
    await expect(applySkeleton(client, created, await skeleton('shop'))).rejects.toThrow(
      'Could not move the branch main to the skeleton commit: GitHub answered HTTP 422 (Update is not a fast forward)',
    );
    expect(repositoryHistory(repository('shop'))).toHaveLength(1);
  });

  it('refuses a name already taken, with GitHub explanation', async () => {
    await expect(
      createRepository(client, { name: 'notes', description: '', private: true }),
    ).rejects.toThrow(
      'Could not create the repository notes: GitHub answered HTTP 422 (Repository creation failed.: name already exists on this account)',
    );
  });

  it('reports a missing Administration permission and records it for "Needs you"', async () => {
    await connect({ permissions: { ...fullAccount().permissions, administration: 'read' } });
    await expect(
      createRepository(client, { name: 'shop', description: '', private: true }),
    ).rejects.toThrow(
      'Could not create the repository shop: the GitHub token is missing a permission (administration=write)',
    );
    expect(await problems()).toContainEqual(
      expect.objectContaining({ type: 'permission_refused', request: 'POST /user/repos' }),
    );
  });
});

describe('branch protection', () => {
  async function created(isPrivate: boolean) {
    return createRepository(client, { name: 'shop', description: '', private: isPrivate });
  }

  it('applies a ruleset on a public repository: pull request and skeleton CI required', async () => {
    const repo = await created(false);
    expect(await applyBranchProtection(client, repo)).toEqual({ status: 'applied' });
    const [ruleset] = repository('shop').rulesets ?? [];
    expect(ruleset?.name).toBe(RULESET_NAME);
    expect(ruleset?.body).toMatchObject({
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } },
      rules: [
        { type: 'pull_request' },
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: REQUIRED_CHECK }] },
        },
      ],
    });
  });

  it('applies it on a private repository with a paid plan', async () => {
    await connect({ plan: 'pro' });
    expect(await applyBranchProtection(client, await created(true))).toEqual({
      status: 'applied',
    });
  });

  it('is not available on a private repository with GitHub Free, which is not a refusal', async () => {
    expect(await applyBranchProtection(client, await created(true))).toEqual({
      status: 'not_available',
    });
    expect(repository('shop').rulesets).toBeUndefined();
    expect(await problems()).toEqual([]);
  });

  it('fails when the token is refused, and records the refusal', async () => {
    const repo = await created(false);
    account.permissions.administration = 'read';
    expect(await applyBranchProtection(client, repo)).toEqual({
      status: 'failed',
      reason:
        'Could not protect the default branch: the GitHub token is missing a permission (administration=write)',
    });
    expect(await problems()).toContainEqual(
      expect.objectContaining({
        type: 'permission_refused',
        request: 'POST /repos/octo-owner/shop/rulesets',
      }),
    );
  });

  it('counts a ruleset left by an earlier attempt as applied, without a second one', async () => {
    const repo = await created(false);
    await applyBranchProtection(client, repo);
    expect(await applyBranchProtection(client, repo)).toEqual({ status: 'applied' });
    expect(repository('shop').rulesets).toHaveLength(1);
  });
});

describe('harness elements', () => {
  it('finds every element in a repository with the skeleton', async () => {
    const repo = await createRepository(client, { name: 'shop', description: '', private: true });
    await applySkeleton(client, repo, await skeleton('shop'));
    expect(await findMissingHarness(client, repo)).toEqual([]);
  });

  it('lists the missing ones, in the order of 08 section 3.4', async () => {
    await connect({
      repositories: [
        {
          name: 'legacy',
          private: false,
          files: {
            'README.md': '# Legacy',
            'docs/user/guide.md': 'Guide',
            'docs/devices.md': 'Not developer documentation',
            // GitHub runs only workflows directly in .github/workflows.
            '.github/workflows/old/ci.yml': 'name: old',
            '.github/workflows/notes.txt': 'not a workflow',
          },
        },
      ],
    });
    expect(
      await findMissingHarness(client, {
        owner: 'octo-owner',
        name: 'legacy',
        defaultBranch: 'main',
      }),
    ).toEqual(['claude_md', 'dev_docs', 'adrs', 'ci_workflow']);
    // Reading changes nothing.
    expect(github.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('finds a .yaml workflow and files in subfolders', async () => {
    await connect({
      repositories: [
        {
          name: 'app',
          private: true,
          files: {
            'CLAUDE.md': '# App',
            'docs/user/tasks/send.md': 'Send',
            'docs/dev/setup.md': 'Setup',
            'docs/adr/0001-x.md': 'ADR',
            '.github/workflows/build.yaml': 'name: build',
          },
        },
      ],
    });
    expect(
      await findMissingHarness(client, { owner: 'octo-owner', name: 'app', defaultBranch: 'main' }),
    ).toEqual([]);
  });

  it('reports every element missing on an empty repository', async () => {
    await connect({ repositories: [{ name: 'blank', private: true, empty: true }] });
    expect(
      await findMissingHarness(client, {
        owner: 'octo-owner',
        name: 'blank',
        defaultBranch: 'main',
      }),
    ).toEqual(['claude_md', 'user_docs', 'dev_docs', 'adrs', 'ci_workflow']);
  });
});

describe('repositories of the account', () => {
  it('lists every repository of the owner, over several pages', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      name: `repo-${String(i)}`,
      private: i % 2 === 0,
      archived: i === 3,
    }));
    await connect({ repositories: many });
    const listed = await listOwnerRepositories(client);
    expect(listed).toHaveLength(150);
    expect(listed[3]).toEqual({
      owner: 'octo-owner',
      name: 'repo-3',
      private: false,
      archived: true,
      defaultBranch: 'main',
      createdAt: '2020-01-01T00:00:00Z',
    });
    expect(requestsTo('GET', /^\/user\/repos\?affiliation=owner/)).toHaveLength(2);
  });

  it('tells whether a name is free', async () => {
    expect(await findRepository(client, { owner: 'octo-owner', name: 'notes' })).toMatchObject({
      name: 'notes',
      private: true,
    });
    expect(await findRepository(client, { owner: 'octo-owner', name: 'shop' })).toBeNull();
  });
});
