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
import { defaultSettings } from '../src/settings.js';
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

  it('cannot tell Workflows apart when Contents is missing and GitHub sends no header', async () => {
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
      reason: 'Contents must be OK before Workflows can be checked',
    });
    expect(results(status).contents).toBe('missing');
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
      pull_requests: 'ok',
      workflows: 'ok',
      statuses: 'could_not_verify',
      actions: 'could_not_verify',
      metadata: 'could_not_verify',
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
          settings: defaultSettings,
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
      settings: defaultSettings,
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
