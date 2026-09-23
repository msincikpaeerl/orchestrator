import { schema } from '@orchestrator/db';
import {
  ApiError,
  AvailabilityResponse,
  LinkableRepositoriesResponse,
  NeedsYouResponse,
  Project,
  ProjectListResponse,
} from '@orchestrator/protocol';
import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INTERRUPTED_REASON, failInterruptedSetups } from '../src/projects/setup.js';
import {
  fullAccount,
  repositoryFiles,
  repositoryHistory,
  startFakeGitHub,
  type FakeAccount,
  type FakeGitHub,
  type FakeRepository,
} from './fake-github.js';
import { createOwner, startTestApp, type TestApp } from './helpers.js';

const TOKEN = 'github_pat_11AAAAAAA0secretTokenValue1234567890';

let github: FakeGitHub;
let t: TestApp;
let cookie: string;
let account: FakeAccount;

beforeAll(async () => {
  github = await startFakeGitHub();
});

afterAll(async () => {
  await github.close();
});

async function connect(overrides: Partial<FakeAccount> = {}) {
  account = fullAccount({
    repositories: [
      { name: 'notes', private: true },
      { name: 'legacy', private: false, files: { 'README.md': '# Legacy', 'docs/user/a.md': 'A' } },
      { name: 'old-site', private: false, archived: true },
    ],
    ...overrides,
  });
  github.accounts.set(TOKEN, account);
  const saved = await t.app.inject({
    method: 'PUT',
    url: '/api/github/token',
    headers: { cookie },
    payload: { token: TOKEN, expiresOn: null },
  });
  expect(saved.statusCode, saved.body).toBe(200);
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

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) {
  return t.app.inject({ method, url, headers: { cookie }, payload });
}

function errorCode(response: { json: () => unknown }) {
  return ApiError.parse(response.json()).error.code;
}

const newRepository = {
  name: 'Online Shop',
  key: 'SHOP',
  kind: 'web_app',
  description: 'Sells things',
  repository: { origin: 'created', name: 'online-shop', private: true },
};

const linkLegacy = {
  name: 'Legacy',
  key: 'LEG',
  kind: 'website',
  repository: { origin: 'linked', name: 'legacy' },
};

async function project(key: string): Promise<Project> {
  const response = await call('GET', `/api/projects/${key}`);
  expect(response.statusCode, response.body).toBe(200);
  return Project.parse(response.json());
}

/** Waits for the background setup to finish. */
async function settled(key: string): Promise<Project> {
  for (let i = 0; i < 200; i++) {
    const current = await project(key);
    if (current.setup.status !== 'in_progress') return current;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`setup of ${key} did not finish`);
}

async function create(body: object): Promise<Project> {
  const response = await call('POST', '/api/projects', body);
  expect(response.statusCode, response.body).toBe(201);
  const created = Project.parse(response.json());
  expect(created.setup.status).toBe('in_progress');
  return created;
}

async function events(type?: string) {
  const rows = await t.db.select().from(schema.events).orderBy(asc(schema.events.id));
  return rows
    .filter((row) => row.type.startsWith('project.') && (type === undefined || row.type === type))
    .map((row) => ({ actor: row.actor, type: row.type, payload: row.payload }));
}

async function needsYou() {
  const response = await call('GET', '/api/needs-you');
  expect(response.statusCode, response.body).toBe(200);
  return NeedsYouResponse.parse(response.json()).items;
}

const writes = () => github.requests.filter((request) => request.method !== 'GET');

describe('creating a project with a new repository', () => {
  it('creates a private repository with the skeleton; branch protection not available on Free', async () => {
    const created = await create(newRepository);
    expect(created).toMatchObject({
      key: 'SHOP',
      name: 'Online Shop',
      slug: 'online-shop',
      kind: 'web_app',
      repository: { owner: 'octo-owner', name: 'online-shop', origin: 'created', private: true },
      setup: { status: 'in_progress', step: 'repository', failure: null },
      status: 'active',
    });

    const ready = await settled('SHOP');
    expect(ready).toMatchObject({
      repository: { defaultBranch: 'main', private: true },
      setup: { status: 'ready', step: null, failure: null },
      branchProtection: 'not_available',
      harness: null,
    });
    expect(repositoryHistory(repository('online-shop')).map((c) => c.message)).toEqual([
      'chore: add the project skeleton',
      'Initial commit',
    ]);
    expect(repositoryFiles(repository('online-shop'))['README.md']).toContain('Online Shop');

    expect(await events()).toEqual([
      {
        actor: 'owner',
        type: 'project.created',
        payload: {
          key: 'SHOP',
          name: 'Online Shop',
          kind: 'web_app',
          origin: 'created',
          repository: 'octo-owner/online-shop',
          private: true,
        },
      },
      expect.objectContaining({
        type: 'project.setup_step',
        payload: expect.objectContaining({ step: 'repository' }) as unknown,
      }),
      expect.objectContaining({
        type: 'project.setup_step',
        payload: expect.objectContaining({ step: 'skeleton', alreadyApplied: false }) as unknown,
      }),
      {
        actor: 'system',
        type: 'project.setup_step',
        payload: { key: 'SHOP', step: 'branch_protection', branchProtection: 'not_available' },
      },
      { actor: 'system', type: 'project.ready', payload: { key: 'SHOP' } },
    ]);
    expect(await needsYou()).toEqual([]);
  });

  it('applies branch protection on a public repository', async () => {
    await create({
      ...newRepository,
      repository: { origin: 'created', name: 'online-shop', private: false },
    });
    expect(await settled('SHOP')).toMatchObject({
      repository: { private: false },
      branchProtection: 'applied',
    });
    expect(repository('online-shop').rulesets).toHaveLength(1);
  });

  it.each([
    ['too short', 'S'],
    ['too long', 'SHOPPING'],
    ['lowercase', 'shop'],
    ['with a digit', 'SH0P'],
  ])('refuses a key %s', async (_, key) => {
    const response = await call('POST', '/api/projects', { ...newRepository, key });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('invalid_request');
  });

  it('refuses a key already used, archived projects included', async () => {
    await create(newRepository);
    await settled('SHOP');
    expect((await call('POST', '/api/projects/SHOP/archive')).statusCode).toBe(200);
    const response = await call('POST', '/api/projects', {
      ...newRepository,
      repository: { origin: 'created', name: 'other', private: true },
    });
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('project_key_taken');
  });

  it('gives one key to only one of two simultaneous requests', async () => {
    const responses = await Promise.all([
      call('POST', '/api/projects', newRepository),
      call('POST', '/api/projects', {
        ...newRepository,
        repository: { origin: 'created', name: 'second', private: true },
      }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    await settled('SHOP');
  });

  it('refuses a repository name already taken on GitHub, without saving the project', async () => {
    const response = await call('POST', '/api/projects', {
      ...newRepository,
      repository: { origin: 'created', name: 'notes', private: true },
    });
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('repository_name_taken');
    expect(await t.db.select().from(schema.projects)).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it('refuses a repository name GitHub would not accept', async () => {
    const response = await call('POST', '/api/projects', {
      ...newRepository,
      repository: { origin: 'created', name: 'my shop', private: true },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses when GitHub is not connected', async () => {
    await t.pool.query('DELETE FROM github_connection; DELETE FROM secrets');
    const response = await call('POST', '/api/projects', newRepository);
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('github_not_connected');
  });

  it('fails the setup with the reason when GitHub refuses, and "Needs you" lists it', async () => {
    account.permissions.administration = 'read';
    await create(newRepository);
    const failed = await settled('SHOP');
    expect(failed.setup).toEqual({
      status: 'failed',
      step: 'repository',
      failure:
        'Could not create the repository online-shop: the GitHub token is missing a permission (administration=write)',
    });
    expect(await events('project.setup_failed')).toEqual([
      {
        actor: 'system',
        type: 'project.setup_failed',
        payload: { key: 'SHOP', step: 'repository', reason: failed.setup.failure },
      },
    ]);
    expect(await needsYou()).toEqual([
      {
        type: 'project_setup_failed',
        project: { key: 'SHOP', name: 'Online Shop' },
        step: 'repository',
        reason: failed.setup.failure,
        since: expect.any(String) as unknown,
      },
    ]);
  });

  it('fails the setup when GitHub cannot be reached', async () => {
    github.override = (request) =>
      request.method === 'POST' ? { status: 503, body: { message: 'Unavailable' } } : undefined;
    await create(newRepository);
    expect((await settled('SHOP')).setup.failure).toBe(
      'GitHub could not be reached: try again later',
    );
  });

  it('fails the setup when branch protection is refused', async () => {
    github.override = (request) =>
      request.method === 'POST' && request.path.endsWith('/rulesets')
        ? { status: 422, body: { message: 'Validation Failed' } }
        : undefined;
    await create({
      ...newRepository,
      repository: { origin: 'created', name: 'online-shop', private: false },
    });
    const failed = await settled('SHOP');
    expect(failed.branchProtection).toBe('failed');
    expect(failed.setup).toMatchObject({ status: 'failed', step: 'branch_protection' });
  });
});

describe('trying the setup again', () => {
  it('resumes from the failed step, with no second repository or commit', async () => {
    account.permissions.workflows = 'read';
    await create(newRepository);
    const failed = await settled('SHOP');
    expect(failed.setup).toMatchObject({ status: 'failed', step: 'skeleton' });
    expect(failed.setup.failure).toContain('(workflows=write)');

    account.permissions.workflows = 'write';
    github.requests.length = 0;
    const retried = await call('POST', '/api/projects/SHOP/setup/retry');
    expect(retried.statusCode, retried.body).toBe(202);
    expect(Project.parse(retried.json()).setup).toEqual({
      status: 'in_progress',
      step: 'skeleton',
      failure: null,
    });
    expect(await settled('SHOP')).toMatchObject({ setup: { status: 'ready' } });

    expect(github.requests.some((r) => r.method === 'POST' && r.path === '/user/repos')).toBe(
      false,
    );
    expect(repositoryHistory(repository('online-shop'))).toHaveLength(2);
    expect((await events()).map((event) => event.type)).toEqual([
      'project.created',
      'project.setup_step',
      'project.setup_failed',
      'project.setup_retried',
      'project.setup_step',
      'project.setup_step',
      'project.ready',
    ]);
    expect(await needsYou()).toEqual([]);
  });

  it('is refused unless the setup failed', async () => {
    await create(newRepository);
    await settled('SHOP');
    const response = await call('POST', '/api/projects/SHOP/setup/retry');
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('project_setup_not_failed');
  });

  it('marks a setup interrupted by a restart as failed, so it can be tried again', async () => {
    await create(newRepository);
    await settled('SHOP');
    // The server stopped during the skeleton step.
    await t.db
      .update(schema.projects)
      .set({ setupStatus: 'in_progress', setupStep: 'skeleton' })
      .where(eq(schema.projects.key, 'SHOP'));

    expect(await failInterruptedSetups(t.db)).toBe(1);
    expect((await project('SHOP')).setup).toEqual({
      status: 'failed',
      step: 'skeleton',
      failure: INTERRUPTED_REASON,
    });
    expect(await needsYou()).toHaveLength(1);

    expect((await call('POST', '/api/projects/SHOP/setup/retry')).statusCode).toBe(202);
    expect((await settled('SHOP')).setup.status).toBe('ready');
    // The skeleton was already there: nothing committed twice.
    expect(repositoryHistory(repository('online-shop'))).toHaveLength(2);
  });

  it('uses the repository an interrupted attempt created', async () => {
    // GitHub created the repository, but the server stopped before reading the answer.
    github.override = (request) =>
      request.method === 'POST' && request.path === '/user/repos'
        ? { status: 503, body: { message: 'Unavailable' } }
        : undefined;
    await create(newRepository);
    await settled('SHOP');
    account.repositories.push({ name: 'online-shop', private: true });

    github.override = undefined;
    github.requests.length = 0;
    expect((await call('POST', '/api/projects/SHOP/setup/retry')).statusCode).toBe(202);
    expect((await settled('SHOP')).setup.status).toBe('ready');
    expect(github.requests.some((r) => r.method === 'POST' && r.path === '/user/repos')).toBe(
      false,
    );
    expect(repositoryHistory(repository('online-shop'))).toHaveLength(2);
  });
});

describe('linking an existing repository', () => {
  it('writes nothing to the repository and lists the missing harness elements', async () => {
    const created = await create(linkLegacy);
    expect(created).toMatchObject({
      slug: 'legacy',
      repository: {
        name: 'legacy',
        origin: 'linked',
        private: false,
        defaultBranch: 'main',
      },
      setup: { step: 'harness' },
      branchProtection: 'not_applied',
    });
    const ready = await settled('LEG');
    expect(ready.setup.status).toBe('ready');
    expect(ready.harness?.missing).toEqual(['claude_md', 'dev_docs', 'adrs', 'ci_workflow']);
    expect(writes()).toEqual([]);
    expect(repositoryHistory(repository('legacy'))).toHaveLength(1);
  });

  it('checks the harness elements again on request', async () => {
    await create(linkLegacy);
    const first = await settled('LEG');
    const legacy = repository('legacy');
    legacy.git = undefined;
    legacy.files = {
      'CLAUDE.md': '# Legacy',
      'docs/user/a.md': 'A',
      'docs/dev/setup.md': 'Setup',
      '.github/workflows/ci.yml': 'name: ci',
    };

    const response = await call('POST', '/api/projects/LEG/harness/check');
    expect(response.statusCode, response.body).toBe(200);
    const checked = Project.parse(response.json());
    expect(checked.harness?.missing).toEqual(['adrs']);
    expect(checked.harness?.checkedAt).not.toBe(first.harness?.checkedAt);
    expect((await events('project.harness_checked'))[0]).toEqual({
      actor: 'owner',
      type: 'project.harness_checked',
      payload: { key: 'LEG', missing: ['adrs'] },
    });
    expect(writes()).toEqual([]);
  });

  it('refuses Check again for a new repository', async () => {
    await create(newRepository);
    await settled('SHOP');
    const response = await call('POST', '/api/projects/SHOP/harness/check');
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('project_not_linked');
  });

  it('refuses a repository that does not exist', async () => {
    const response = await call('POST', '/api/projects', {
      ...linkLegacy,
      repository: { origin: 'linked', name: 'nothing' },
    });
    expect(response.statusCode).toBe(422);
    expect(errorCode(response)).toBe('repository_not_found');
  });

  it('refuses a repository archived on GitHub', async () => {
    const response = await call('POST', '/api/projects', {
      ...linkLegacy,
      repository: { origin: 'linked', name: 'old-site' },
    });
    expect(response.statusCode).toBe(422);
    expect(errorCode(response)).toBe('repository_archived');
  });

  it('refuses a repository already linked, even to an archived project', async () => {
    await create(linkLegacy);
    await settled('LEG');
    await call('POST', '/api/projects/LEG/archive');
    const response = await call('POST', '/api/projects', { ...linkLegacy, key: 'LEGB' });
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('repository_already_linked');
  });

  it('lists the repositories that can be linked', async () => {
    await create(linkLegacy);
    await settled('LEG');
    const response = await call('GET', '/api/projects/linkable-repositories');
    expect(response.statusCode, response.body).toBe(200);
    expect(LinkableRepositoriesResponse.parse(response.json()).repositories).toEqual([
      { name: 'notes', private: true, defaultBranch: 'main' },
    ]);
  });

  it('reports a GitHub refusal', async () => {
    github.override = (request) =>
      request.path.startsWith('/user/repos')
        ? {
            status: 403,
            body: { message: 'Resource not accessible by personal access token' },
            headers: { 'x-accepted-github-permissions': 'metadata=read' },
          }
        : undefined;
    const response = await call('GET', '/api/projects/linkable-repositories');
    expect(response.statusCode).toBe(502);
    expect(ApiError.parse(response.json()).error).toEqual({
      code: 'github_request_failed',
      message:
        'Could not list your repositories: the GitHub token is missing a permission (metadata=read)',
    });
  });
});

describe('availability of a key and a repository name', () => {
  it('tells whether each is free, taken or invalid', async () => {
    await create(newRepository);
    await settled('SHOP');
    const check = async (query: string) => {
      const response = await call('GET', `/api/projects/availability?${query}`);
      expect(response.statusCode, response.body).toBe(200);
      return AvailabilityResponse.parse(response.json());
    };
    expect(await check('key=SHOP&repositoryName=online-shop')).toEqual({
      key: 'taken',
      repositoryName: 'taken',
    });
    expect(await check('key=WEB&repositoryName=web')).toEqual({
      key: 'free',
      repositoryName: 'free',
    });
    expect(await check('key=web&repositoryName=a%20b')).toEqual({
      key: 'invalid',
      repositoryName: 'invalid',
    });
    expect(await check('key=WEB')).toEqual({ key: 'free' });
  });
});

describe('listing, editing and archiving', () => {
  beforeEach(async () => {
    await create(newRepository);
    await create(linkLegacy);
    await settled('SHOP');
    await settled('LEG');
    github.requests.length = 0;
  });

  async function list(query = '') {
    const response = await call('GET', `/api/projects${query}`);
    expect(response.statusCode, response.body).toBe(200);
    return ProjectListResponse.parse(response.json()).projects.map((p) => p.key);
  }

  it('needs a session', async () => {
    const response = await t.app.inject({ method: 'GET', url: '/api/projects' });
    expect(response.statusCode).toBe(401);
  });

  it('answers not found for an unknown key', async () => {
    for (const key of ['NOPE', 'nope', 'X']) {
      const response = await call('GET', `/api/projects/${key}`);
      expect(response.statusCode).toBe(404);
      expect(errorCode(response)).toBe('project_not_found');
    }
  });

  it('edits the name and description, never the key', async () => {
    const response = await call('PATCH', '/api/projects/SHOP', {
      name: 'Shop',
      description: 'Sells more things',
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(Project.parse(response.json())).toMatchObject({
      key: 'SHOP',
      name: 'Shop',
      description: 'Sells more things',
      slug: 'online-shop',
    });
    expect(await events('project.updated')).toEqual([
      {
        actor: 'owner',
        type: 'project.updated',
        payload: { key: 'SHOP', name: 'Shop', description: 'Sells more things' },
      },
    ]);
    for (const payload of [{ key: 'SHP' }, { kind: 'website' }, {}]) {
      const refused = await call('PATCH', '/api/projects/SHOP', payload);
      expect(refused.statusCode).toBe(400);
    }
    expect(writes()).toEqual([]);
  });

  it('archives without any request to GitHub, and unarchives', async () => {
    const archived = await call('POST', '/api/projects/SHOP/archive');
    expect(archived.statusCode, archived.body).toBe(200);
    expect(Project.parse(archived.json()).status).toBe('archived');
    expect(await list()).toEqual(['LEG']);
    expect(await list('?archived=true')).toEqual(['LEG', 'SHOP']);
    expect(github.requests).toEqual([]);

    const again = await call('POST', '/api/projects/SHOP/archive');
    expect(errorCode(again)).toBe('project_archived');

    const unarchived = await call('POST', '/api/projects/SHOP/unarchive');
    expect(Project.parse(unarchived.json()).status).toBe('active');
    expect(await list()).toEqual(['LEG', 'SHOP']);
    expect(errorCode(await call('POST', '/api/projects/SHOP/unarchive'))).toBe(
      'project_not_archived',
    );
    expect((await events()).filter((e) => e.type.endsWith('archived'))).toEqual([
      { actor: 'owner', type: 'project.archived', payload: { key: 'SHOP' } },
      { actor: 'owner', type: 'project.unarchived', payload: { key: 'SHOP' } },
    ]);
    expect(github.requests).toEqual([]);
  });

  it('refuses any change to an archived project', async () => {
    await call('POST', '/api/projects/LEG/archive');
    for (const [method, url, payload] of [
      ['PATCH', '/api/projects/LEG', { name: 'Old' }],
      ['POST', '/api/projects/LEG/harness/check', undefined],
      ['POST', '/api/projects/LEG/setup/retry', undefined],
    ] as const) {
      const response = await call(method, url, payload);
      expect(response.statusCode, url).toBe(409);
      expect(errorCode(response)).toBe('project_archived');
    }
    expect((await project('LEG')).name).toBe('Legacy');
  });

  it('refuses archiving while the setup runs', async () => {
    await t.db
      .update(schema.projects)
      .set({ setupStatus: 'in_progress' })
      .where(eq(schema.projects.key, 'SHOP'));
    const response = await call('POST', '/api/projects/SHOP/archive');
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('project_setup_in_progress');
  });

  it('keeps a failed setup of an archived project out of "Needs you" until unarchived', async () => {
    await t.db
      .update(schema.projects)
      .set({ setupStatus: 'in_progress', setupStep: 'branch_protection' })
      .where(eq(schema.projects.key, 'SHOP'));
    await failInterruptedSetups(t.db);
    expect(await needsYou()).toHaveLength(1);
    await call('POST', '/api/projects/SHOP/archive');
    expect(await needsYou()).toEqual([]);
    await call('POST', '/api/projects/SHOP/unarchive');
    expect(await needsYou()).toHaveLength(1);
  });
});
