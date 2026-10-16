import { schema } from '@orchestrator/db';
import {
  ApiError,
  GitHubStatusResponse,
  InspectGitHubTokenResponse,
  type GitHubStatusResponse as Status,
  type PermissionCheck,
} from '@orchestrator/protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { storedTokenClient } from '../src/github/connection.js';
import { deriveSecretKey } from '../src/secrets.js';
import { fullAccount, startFakeGitHub, type FakeAccount, type FakeGitHub } from './fake-github.js';
import { createLogger } from '../src/logger.js';
import { startServer } from '../src/server.js';
import { SecretUnreadableError } from '../src/secrets.js';
import {
  OWNER,
  TEST_SECRET_KEY,
  createOwner,
  sessionCookie,
  startTestApp,
  type TestApp,
} from './helpers.js';

const TOKEN = 'github_pat_11AAAAAAA0secretTokenValue1234567890';

let github: FakeGitHub;
let t: TestApp;
let cookie: string;

beforeAll(async () => {
  github = await startFakeGitHub();
});

afterAll(async () => {
  await github.close();
});

beforeEach(async () => {
  github.accounts.clear();
  github.requests.length = 0;
  github.override = undefined;
  t = await startTestApp({ githubApiUrl: github.url });
  cookie = await createOwner(t.app);
});

afterEach(async () => {
  await t.close();
});

function inDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
  return t.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
}

async function saveToken(account: FakeAccount, expiresOn: string | null = inDays(300)) {
  github.accounts.set(TOKEN, account);
  const response = await call('PUT', '/api/github/token', { token: TOKEN, expiresOn });
  expect(response.statusCode, response.body).toBe(200);
  return GitHubStatusResponse.parse(response.json());
}

function results(status: Status): Record<string, string> {
  if (!status.connected) throw new Error('not connected');
  return Object.fromEntries(status.permissions.map((check) => [check.permission, check.result]));
}

function connected(status: Status) {
  if (!status.connected) throw new Error('not connected');
  return status;
}

describe('authentication', () => {
  it.each([
    ['GET', '/api/github'],
    ['POST', '/api/github/token/inspect'],
    ['PUT', '/api/github/token'],
    ['POST', '/api/github/token/check'],
  ] as const)('refuses %s %s without a session', async (method, url) => {
    const response = await t.app.inject({
      method,
      url,
      payload: { token: TOKEN, expiresOn: null },
    });
    expect(response.statusCode).toBe(401);
    expect(github.requests).toEqual([]);
  });
});

describe('POST /api/github/token/inspect', () => {
  it('returns the account and a plausible expiry date from the header', async () => {
    github.accounts.set(TOKEN, fullAccount({ expirationHeader: `${inDays(200)} 12:00:00 UTC` }));
    const response = await call('POST', '/api/github/token/inspect', { token: TOKEN });
    expect(response.statusCode).toBe(200);
    expect(InspectGitHubTokenResponse.parse(response.json())).toEqual({
      account: 'octo-owner',
      suggestedExpiresOn: inDays(200),
    });
  });

  it('ignores an expiry header giving the request time', async () => {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    github.accounts.set(TOKEN, fullAccount({ expirationHeader: `${now} +0000` }));
    const response = await call('POST', '/api/github/token/inspect', { token: TOKEN });
    expect(response.json()).toMatchObject({ suggestedExpiresOn: null });
  });

  it('refuses a token GitHub rejects', async () => {
    const response = await call('POST', '/api/github/token/inspect', { token: TOKEN });
    expect(response.statusCode).toBe(422);
    expect(ApiError.parse(response.json()).error.code).toBe('github_token_invalid');
  });

  it('refuses a classic token without sending it to GitHub', async () => {
    const response = await call('POST', '/api/github/token/inspect', {
      token: 'ghp_classicTokenValue',
    });
    expect(response.statusCode).toBe(422);
    expect(ApiError.parse(response.json()).error.code).toBe('github_token_not_fine_grained');
    expect(github.requests).toEqual([]);
  });

  it('answers 502 when GitHub fails', async () => {
    github.override = () => ({ status: 503 });
    const response = await call('POST', '/api/github/token/inspect', { token: TOKEN });
    expect(response.statusCode).toBe(502);
    expect(ApiError.parse(response.json()).error.code).toBe('github_unreachable');
  });
});

describe('PUT /api/github/token', () => {
  it('saves a token with every permission: all OK, no problem, setup step done', async () => {
    const status = connected(await saveToken(fullAccount(), inDays(300)));
    expect(status.account).toBe('octo-owner');
    expect(status.expiresOn).toBe(inDays(300));
    expect(status.permissions.every((check) => check.result === 'ok')).toBe(true);
    expect(status.problems).toEqual([]);
    const setup = await t.app.inject({ method: 'GET', url: '/api/setup' });
    expect(setup.json()).toEqual({ ownerCreated: true, githubConnected: true });
    const events = await t.db.select({ type: schema.events.type }).from(schema.events);
    expect(events.map((event) => event.type)).toContain('github.token_saved');
  });

  it('accepts "No expiry date"', async () => {
    const status = connected(await saveToken(fullAccount(), null));
    expect(status.expiresOn).toBeNull();
    expect(status.problems).toEqual([]);
  });

  it('never creates or changes anything on GitHub: write probes are invalid requests', async () => {
    await saveToken(fullAccount());
    const writes = github.requests.filter((request) => request.method !== 'GET');
    expect(
      writes.map((request) => [request.method, request.path.split('?')[0], request.body]),
    ).toEqual([
      ['POST', '/user/repos', { name: '' }],
      ['PUT', '/repos/octo-owner/notes/contents/.orchestrator-token-check', {}],
      ['POST', '/repos/octo-owner/notes/pulls', {}],
      [
        'PUT',
        '/repos/octo-owner/notes/contents/.github/workflows/orchestrator-token-check.yml',
        {},
      ],
    ]);
  });

  it('reports each missing permission as Missing and as a problem', async () => {
    const status = connected(
      await saveToken(
        fullAccount({ permissions: { metadata: 'read', contents: 'write', statuses: 'read' } }),
      ),
    );
    expect(results(status)).toEqual({
      administration: 'missing',
      contents: 'ok',
      pull_requests: 'missing',
      workflows: 'missing',
      statuses: 'ok',
      actions: 'missing',
      metadata: 'ok',
    });
    expect(status.problems).toEqual(
      ['administration', 'pull_requests', 'workflows', 'actions'].map((permission) => ({
        type: 'permission_missing',
        permission,
        access: permission === 'actions' ? 'read' : 'write',
      })),
    );
  });

  // Found with the real GitHub in lot 0 step E: writing a workflow file needs Contents write
  // first, so GitHub refuses the Workflows probe naming both permissions.
  it('says Could not verify for Workflows, not Missing, when Contents is read-only', async () => {
    const status = await saveToken(
      fullAccount({ permissions: { ...fullAccount().permissions, contents: 'read' } }),
    );
    const workflows = connected(status).permissions.find((c) => c.permission === 'workflows');
    expect(workflows).toEqual<PermissionCheck>({
      permission: 'workflows',
      access: 'write',
      result: 'could_not_verify',
      reason: 'Requires Contents (Read and write) first',
    });
    expect(results(status).contents).toBe('missing');
    expect(connected(status).problems).toEqual([
      { type: 'permission_missing', permission: 'contents', access: 'write' },
    ]);
  });

  it('does not probe Workflows when Contents is missing, even without a refusal header', async () => {
    const status = await saveToken(
      fullAccount({
        permissions: { metadata: 'read', workflows: 'write' },
        acceptedPermissionsHeader: false,
      }),
    );
    const workflows = connected(status).permissions.find((c) => c.permission === 'workflows');
    expect(workflows).toEqual<PermissionCheck>({
      permission: 'workflows',
      access: 'write',
      result: 'could_not_verify',
      reason: 'Requires Contents (Read and write) first',
    });
    expect(results(status).contents).toBe('missing');
    expect(github.requests.some((request) => request.path.includes('.github/workflows'))).toBe(
      false,
    );
  });

  it('says Could not verify for repository permissions when there is no repository', async () => {
    const status = await saveToken(fullAccount({ repositories: [] }));
    expect(results(status)).toEqual({
      administration: 'ok',
      contents: 'could_not_verify',
      pull_requests: 'could_not_verify',
      workflows: 'could_not_verify',
      statuses: 'could_not_verify',
      actions: 'could_not_verify',
      metadata: 'could_not_verify',
    });
    expect(connected(status).problems).toEqual([]);
  });

  it('uses a public repository for write probes only', async () => {
    const status = await saveToken(
      fullAccount({ repositories: [{ name: 'site', private: false }] }),
    );
    expect(results(status)).toMatchObject({
      contents: 'ok',
      // Its read probe needs a private repository (lot 3 step E1).
      pull_requests: 'could_not_verify',
      workflows: 'ok',
      statuses: 'could_not_verify',
      actions: 'could_not_verify',
      metadata: 'could_not_verify',
    });
  });

  // Lot 3 step E1 (owner's answer 1): Pull requests is probed for reading and for writing, and
  // reads OK only when both probes are OK.
  it('probes Pull requests for reading too, with a list request on a private repository', async () => {
    await saveToken(fullAccount());
    expect(
      github.requests.some(
        (request) =>
          request.method === 'GET' && request.path === '/repos/octo-owner/notes/pulls?per_page=1',
      ),
    ).toBe(true);
  });

  it('says Missing for Pull requests when only its read probe is refused', async () => {
    github.override = (request) =>
      request.method === 'GET' && request.path.startsWith('/repos/octo-owner/notes/pulls')
        ? {
            status: 403,
            body: { message: 'Resource not accessible by personal access token' },
            headers: { 'x-accepted-github-permissions': 'pull_requests=read' },
          }
        : undefined;
    const status = connected(await saveToken(fullAccount()));
    expect(results(status).pull_requests).toBe('missing');
    expect(status.problems).toEqual([
      { type: 'permission_missing', permission: 'pull_requests', access: 'write' },
    ]);
  });

  it('says Could not verify for Pull requests when its read probe cannot tell', async () => {
    github.override = (request) =>
      request.method === 'GET' && request.path.startsWith('/repos/octo-owner/notes/pulls')
        ? { status: 404, body: { message: 'Not Found' } }
        : undefined;
    const pullRequests = connected(await saveToken(fullAccount())).permissions.find(
      (check) => check.permission === 'pull_requests',
    );
    expect(pullRequests).toEqual<PermissionCheck>({
      permission: 'pull_requests',
      access: 'write',
      result: 'could_not_verify',
      reason: 'Unexpected answer from GitHub (HTTP 404)',
    });
  });

  it('says Could not verify for commit statuses on an empty repository', async () => {
    const status = await saveToken(
      fullAccount({ repositories: [{ name: 'new', private: true, empty: true }] }),
    );
    expect(results(status).statuses).toBe('could_not_verify');
  });

  it('refuses an expiry date in the past without contacting GitHub', async () => {
    github.accounts.set(TOKEN, fullAccount());
    const response = await call('PUT', '/api/github/token', {
      token: TOKEN,
      expiresOn: inDays(-1),
    });
    expect(response.statusCode).toBe(422);
    expect(ApiError.parse(response.json()).error.code).toBe('expiry_date_in_past');
    expect(github.requests).toEqual([]);
  });

  it('refuses a token GitHub rejects and saves nothing', async () => {
    const response = await call('PUT', '/api/github/token', { token: TOKEN, expiresOn: null });
    expect(response.statusCode).toBe(422);
    expect(await t.db.select().from(schema.secrets)).toEqual([]);
    expect(await t.db.select().from(schema.githubConnection)).toEqual([]);
  });

  it('warns when the expiry date is within the warning delay', async () => {
    const status = connected(await saveToken(fullAccount(), inDays(14)));
    expect(status.problems).toEqual([{ type: 'token_expiring', expiresOn: inDays(14) }]);
    const later = connected(await saveToken(fullAccount(), inDays(15)));
    expect(later.problems).toEqual([]);
  });
});

describe("the GitHub account's id (for the address of agent commits)", () => {
  async function storedId() {
    const [row] = await t.db.select().from(schema.githubConnection);
    return row?.accountId;
  }

  it('is read from GET /user and stored when the token is saved', async () => {
    await saveToken(fullAccount({ id: 4_242_424 }));
    expect(await storedId()).toBe(4_242_424);
  });

  it('is stored at the next check for a token saved before 0.3.0', async () => {
    await saveToken(fullAccount({ id: 4_242_424 }));
    // As saved by 0.2.0: no id.
    await t.db.update(schema.githubConnection).set({ accountId: null });
    const check = await call('POST', '/api/github/token/check');
    expect(check.statusCode, check.body).toBe(200);
    expect(await storedId()).toBe(4_242_424);
  });
});

describe('the token never leaves the server', () => {
  it('is not in any answer, log line, event or database column in clear', async () => {
    github.accounts.set(TOKEN, fullAccount());
    const answers = [
      await call('POST', '/api/github/token/inspect', { token: TOKEN }),
      await call('PUT', '/api/github/token', { token: TOKEN, expiresOn: null }),
      await call('GET', '/api/github'),
      await call('POST', '/api/github/token/check'),
    ];
    for (const answer of answers) {
      expect(answer.statusCode).toBe(200);
      expect(answer.body).not.toContain(TOKEN);
      expect(JSON.stringify(answer.headers)).not.toContain(TOKEN);
    }
    expect(t.logs.text).not.toContain(TOKEN);
    expect(t.logs.lines.length).toBeGreaterThan(0);

    const { rows } = await t.pool.query<{ dump: string }>(
      `SELECT concat_ws(' ', (SELECT json_agg(s)::text FROM secrets s),
                             (SELECT json_agg(e)::text FROM events e),
                             (SELECT json_agg(g)::text FROM github_connection g)) AS dump`,
    );
    const dump = rows[0]?.dump ?? '';
    expect(dump).toContain('github.token_saved');
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain(Buffer.from(TOKEN).toString('hex'));
    // The fake received it only in the Authorization header.
    expect(github.requests.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(
      true,
    );
    expect(JSON.stringify(github.requests.map((request) => request.body))).not.toContain(TOKEN);
  });

  it('is sent to GitHub only in the Authorization header when a request fails', async () => {
    github.override = () => ({ status: 500 });
    const response = await call('POST', '/api/github/token/inspect', { token: TOKEN });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain(TOKEN);
    expect(t.logs.text).not.toContain(TOKEN);
  });
});

describe('ORCHESTRATOR_SECRET_KEY lost or changed', () => {
  const otherKey = 'another-secret-key-of-at-least-32-characters';

  it('keeps the server running and asks in "Needs you" to enter the token again', async () => {
    await saveToken(fullAccount());
    // Restart on the same database with another key.
    const server = await startServer(
      { databaseUrl: t.database.url, port: 0, secretKey: otherKey, publicUrl: 'http://localhost' },
      createLogger('silent'),
      { githubApiUrl: github.url },
    );
    try {
      const { app } = server;
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: OWNER });
      const otherCookie = sessionCookie(login.headers['set-cookie']);
      const get = (url: string, method: 'GET' | 'POST' = 'GET') =>
        app.inject({ method, url, headers: { cookie: otherCookie } });

      // Detected at start, before any use of the token.
      const status = connected(GitHubStatusResponse.parse((await get('/api/github')).json()));
      expect(status.problems.map((problem) => problem.type)).toEqual(['token_unreadable']);

      const check = await get('/api/github/token/check', 'POST');
      expect(check.statusCode).toBe(409);
      expect(ApiError.parse(check.json()).error.code).toBe('github_token_unreadable');
      await expect(
        storedTokenClient({
          db: t.db,
          key: deriveSecretKey(otherKey),
          apiUrl: github.url,
        }),
      ).rejects.toThrow(SecretUnreadableError);
      const events = await t.db.select({ type: schema.events.type }).from(schema.events);
      expect(events.filter((event) => event.type === 'github.token_unreadable')).toHaveLength(1);

      // Entering the token again clears the problem.
      const saved = await app.inject({
        method: 'PUT',
        url: '/api/github/token',
        headers: { cookie: otherCookie },
        payload: { token: TOKEN, expiresOn: null },
      });
      expect(connected(GitHubStatusResponse.parse(saved.json())).problems).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

// The owner's real run of 2026-10-16 (lot 3 step K1): a fine-grained token limited to its test
// repository read Contents and Pull requests Missing, because the write probes ran on the
// account's most recently pushed public repository, outside the token's repositories.
describe('a token limited to one repository', () => {
  const smokeToken = () =>
    fullAccount({
      permissions: {
        metadata: 'read',
        contents: 'write',
        pull_requests: 'write',
        actions: 'read',
        statuses: 'read',
      },
      // GitHub lists the most recently pushed first.
      repositories: [
        { name: 'orchestrator', private: false },
        { name: 'test-site', private: false },
        { name: 'old-site', private: false, archived: true },
      ],
      selectedRepositories: ['test-site', 'old-site'],
    });

  async function seedProject(name: string, at: Date, status: 'active' | 'archived' = 'active') {
    await t.db.insert(schema.projects).values({
      key: name.replace(/-/g, '').slice(0, 6).toUpperCase(),
      name,
      slug: name,
      description: '',
      kind: 'web_app',
      repoOwner: 'octo-owner',
      repoName: name,
      repoOrigin: 'linked',
      repoPrivate: false,
      defaultBranch: 'main',
      setupStatus: 'ready',
      branchProtection: 'applied',
      status,
      updatedAt: at,
    });
  }

  const probed = () =>
    github.requests
      .filter((request) => request.method !== 'GET' && request.path !== '/user/repos')
      .map((request) => request.path.split('/')[3]);

  it("without a project, never reads Missing for a repository outside the token's", async () => {
    const status = connected(await saveToken(smokeToken()));
    const outside =
      "octo-owner/orchestrator may not be among this token's repositories; create a project, then check again";
    const find = (permission: string) =>
      status.permissions.find((check) => check.permission === permission);
    expect(find('contents')).toMatchObject({ result: 'could_not_verify', reason: outside });
    expect(find('pull_requests')?.result).toBe('could_not_verify');
    expect(find('workflows')?.result).toBe('could_not_verify');
    expect(
      status.permissions.filter((check) => check.result === 'missing').map((c) => c.permission),
    ).toEqual(['administration']);
  });

  it("with a project, probes the project's repository, never an archived one", async () => {
    // The archived repository (on GitHub) and the archived project are updated last: skipped.
    await seedProject('test-site', new Date('2026-10-10T10:00:00Z'));
    await seedProject('old-site', new Date('2026-10-12T10:00:00Z'));
    await seedProject('orchestrator', new Date('2026-10-14T10:00:00Z'), 'archived');
    const status = connected(await saveToken(smokeToken()));
    expect(new Set(probed())).toEqual(new Set(['test-site']));
    expect(results(status)).toMatchObject({
      contents: 'ok',
      // Its read probe needs a private repository, and the token includes none.
      pull_requests: 'could_not_verify',
      // Missing for real: the token does not have it, on a repository it includes.
      workflows: 'missing',
    });
    // Still invalid requests only: nothing created or changed on GitHub.
    expect(
      github.requests.filter((request) => request.method !== 'GET').map((r) => r.body),
    ).toEqual([{ name: '' }, {}, {}, {}]);
  });

  it('with a project and a private repository the token includes, reads OK', async () => {
    const account = smokeToken();
    account.repositories.push({ name: 'notes', private: true });
    account.selectedRepositories?.push('notes');
    await seedProject('test-site', new Date('2026-10-10T10:00:00Z'));
    const status = connected(await saveToken(account));
    expect(results(status)).toMatchObject({
      contents: 'ok',
      pull_requests: 'ok',
      workflows: 'missing',
    });
    expect(new Set(probed())).toEqual(new Set(['test-site']));
  });
});

describe('POST /api/github/token/check', () => {
  it('refuses when no token is saved', async () => {
    const response = await call('POST', '/api/github/token/check');
    expect(response.statusCode).toBe(409);
    expect(ApiError.parse(response.json()).error.code).toBe('github_not_connected');
  });

  it('updates the permissions after the owner changes them on GitHub', async () => {
    await saveToken(fullAccount({ permissions: { metadata: 'read' } }));
    github.accounts.set(TOKEN, fullAccount());
    const response = await call('POST', '/api/github/token/check');
    const status = connected(GitHubStatusResponse.parse(response.json()));
    expect(status.problems).toEqual([]);
  });

  it('reports a token GitHub now rejects, whatever its stored expiry date', async () => {
    await saveToken(fullAccount(), inDays(300));
    github.accounts.clear();
    const response = await call('POST', '/api/github/token/check');
    expect(response.statusCode).toBe(200);
    const status = connected(GitHubStatusResponse.parse(response.json()));
    expect(status.problems.map((problem) => problem.type)).toEqual(['token_invalid']);
  });
});

describe('refusals during normal operation (the safety net)', () => {
  async function client() {
    const stored = await storedTokenClient({
      db: t.db,
      key: deriveSecretKey(TEST_SECRET_KEY),
      apiUrl: github.url,
    });
    if (!stored) throw new Error('no token');
    return stored;
  }

  async function status() {
    return connected(GitHubStatusResponse.parse((await call('GET', '/api/github')).json()));
  }

  it('turns a "not accessible" refusal into a problem naming the permission, once', async () => {
    await saveToken(
      fullAccount({ permissions: { ...fullAccount().permissions, pull_requests: 'read' } }),
    );
    // The check already found it missing; a refusal during use is recorded separately.
    const github = await client();
    for (let attempt = 0; attempt < 2; attempt++) {
      await github.request({ method: 'POST', path: '/repos/octo-owner/notes/pulls', body: {} });
    }
    const refused = (await status()).problems.filter((p) => p.type === 'permission_refused');
    expect(refused).toMatchObject([
      {
        type: 'permission_refused',
        permissions: ['pull_requests=write'],
        request: 'POST /repos/octo-owner/notes/pulls',
      },
    ]);
  });

  it('marks the token invalid on a 401 and clears it after a successful check', async () => {
    await saveToken(fullAccount());
    github.accounts.clear();
    await (await client()).request({ method: 'GET', path: '/user' });
    expect((await status()).problems.map((p) => p.type)).toEqual(['token_invalid']);
    const events = await t.db.select({ type: schema.events.type }).from(schema.events);
    expect(events.filter((e) => e.type === 'github.token_rejected')).toHaveLength(1);

    github.accounts.set(TOKEN, fullAccount());
    await call('POST', '/api/github/token/check');
    expect((await status()).problems).toEqual([]);
  });

  it('does not treat a plain 404 as a refusal', async () => {
    await saveToken(fullAccount());
    await (await client()).request({ method: 'GET', path: '/repos/octo-owner/missing/pulls' });
    expect((await status()).problems).toEqual([]);
  });
});
