import { schema } from '@orchestrator/db';
import { ApiError, SessionResponse, SetupStateResponse } from '@orchestrator/protocol';
import { asc, eq, ne } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import { OWNER, createOwner, sessionCookie, startTestApp, type TestApp } from './helpers.js';

let t: TestApp;

beforeEach(async () => {
  t = await startTestApp();
});

afterEach(async () => {
  await t.close();
});

/** Events written since the start, without the default agent profiles seeded by the start. */
async function eventTypes(): Promise<string[]> {
  const rows = await t.db
    .select({ type: schema.events.type })
    .from(schema.events)
    .where(ne(schema.events.entityType, 'agent_profile'))
    .orderBy(asc(schema.events.id));
  return rows.map((row) => row.type);
}

describe('GET /api/setup', () => {
  it('reports that nothing is set up on a new installation', async () => {
    const response = await t.app.inject({ method: 'GET', url: '/api/setup' });
    expect(response.statusCode).toBe(200);
    expect(SetupStateResponse.parse(response.json())).toEqual({
      ownerCreated: false,
      githubConnected: false,
    });
  });

  it('reports the owner once created', async () => {
    await createOwner(t.app);
    const response = await t.app.inject({ method: 'GET', url: '/api/setup' });
    expect(response.json()).toEqual({ ownerCreated: true, githubConnected: false });
  });
});

describe('POST /api/setup/owner', () => {
  it('creates the owner, logs in with a strict HTTP-only cookie and writes events', async () => {
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/setup/owner',
      payload: OWNER,
    });

    expect(response.statusCode).toBe(201);
    expect(SessionResponse.parse(response.json()).username).toBe(OWNER.username);
    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toMatch(/^orchestrator_session=[\w-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Secure');
    expect(await eventTypes()).toEqual(['owner.created', 'session.created']);
  });

  it('stores an Argon2id hash, never the password', async () => {
    await createOwner(t.app);
    const [owner] = await t.db.select().from(schema.owner);
    expect(owner?.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(owner?.passwordHash).not.toContain(OWNER.password);
    expect(t.logs.text).not.toContain(OWNER.password);
  });

  it('refuses a second owner', async () => {
    await createOwner(t.app);
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/setup/owner',
      payload: { username: 'intruder', password: 'another long password' },
    });
    expect(response.statusCode).toBe(409);
    expect(ApiError.parse(response.json()).error.code).toBe('owner_exists');
    const owners = await t.db.select().from(schema.owner);
    expect(owners.map((owner) => owner.username)).toEqual([OWNER.username]);
  });

  it('creates only one owner when two requests race', async () => {
    const responses = await Promise.all(
      ['first', 'second'].map((username) =>
        t.app.inject({
          method: 'POST',
          url: '/api/setup/owner',
          payload: { username, password: OWNER.password },
        }),
      ),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect(await t.db.select().from(schema.owner)).toHaveLength(1);
  });

  it('refuses a password shorter than 12 characters without echoing it', async () => {
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/setup/owner',
      payload: { username: 'owner', password: 'elevenchars' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: 'invalid_request', message: 'password: at least 12 characters' },
    });
    expect(await t.db.select().from(schema.owner)).toEqual([]);
  });

  it('answers malformed JSON without quoting the body in the answer or the logs', async () => {
    const secret = 'correct-horse-in-broken-json';
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/setup/owner',
      headers: { 'content-type': 'application/json' },
      payload: `{"username": "owner", "password": ${secret}}`,
    });
    expect(response.statusCode).toBe(400);
    expect(ApiError.parse(response.json()).error.code).toBe('invalid_request');
    expect(response.body).not.toContain(secret);
    expect(t.logs.text).not.toContain(secret);
  });
});

describe('login, session and logout', () => {
  beforeEach(async () => {
    await createOwner(t.app);
  });

  async function login(payload: object) {
    return t.app.inject({ method: 'POST', url: '/api/auth/login', payload });
  }

  it('logs in with the right password and returns the session', async () => {
    const response = await login(OWNER);
    expect(response.statusCode).toBe(200);
    const cookie = sessionCookie(response.headers['set-cookie']);

    const session = await t.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie },
    });
    expect(session.statusCode).toBe(200);
    expect(SessionResponse.parse(session.json()).username).toBe(OWNER.username);
  });

  it.each([
    ['a wrong password', { username: OWNER.username, password: 'wrong password!' }],
    ['an unknown username', { username: 'someone', password: OWNER.password }],
    ['a short password', { username: OWNER.username, password: 'short' }],
  ])('refuses %s with the same answer', async (_case, payload) => {
    const response = await login(payload);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: 'invalid_credentials', message: 'Wrong username or password' },
    });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('refuses the session endpoint without a cookie or with an unknown one', async () => {
    for (const headers of [{}, { cookie: 'orchestrator_session=forged' }]) {
      const response = await t.app.inject({ method: 'GET', url: '/api/auth/session', headers });
      expect(response.statusCode).toBe(401);
      expect(ApiError.parse(response.json()).error.code).toBe('not_authenticated');
    }
  });

  it('refuses an expired session', async () => {
    const cookie = sessionCookie((await login(OWNER)).headers['set-cookie']);
    await t.db.update(schema.sessions).set({ expiresAt: new Date(Date.now() - 1000) });
    const response = await t.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(401);
  });

  it('logs out: the cookie is cleared and the session no longer works', async () => {
    const cookie = sessionCookie((await login(OWNER)).headers['set-cookie']);
    const logout = await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(204);
    expect(String(logout.headers['set-cookie'])).toMatch(/^orchestrator_session=;/);

    const session = await t.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie },
    });
    expect(session.statusCode).toBe(401);
    const revoked = await t.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.type, 'session.revoked'));
    expect(revoked).toHaveLength(1);
  });

  it('keeps only a hash of the session cookie', async () => {
    const cookie = sessionCookie((await login(OWNER)).headers['set-cookie']);
    const token = cookie.split('=')[1] ?? '';
    const rows = await t.db.select().from(schema.sessions);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.tokenHash).not.toContain(token);
  });
});

describe('Secure cookie flag', () => {
  async function cookieFor(publicUrl: string): Promise<string> {
    const app = buildApp({
      pool: t.pool,
      logger: createLogger('silent'),
      secretKey: 'k'.repeat(32),
      publicUrl,
    });
    try {
      await t.db.delete(schema.owner);
      const response = await app.inject({
        method: 'POST',
        url: '/api/setup/owner',
        payload: OWNER,
      });
      expect(response.statusCode).toBe(201);
      return String(response.headers['set-cookie']);
    } finally {
      await app.close();
    }
  }

  it('is set when PUBLIC_URL is HTTPS', async () => {
    expect(await cookieFor('https://orchestrator.example.net')).toContain('Secure');
  });

  it('is not set over plain HTTP, on localhost or a LAN address, so login works there', async () => {
    expect(await cookieFor('http://localhost:8080')).not.toContain('Secure');
    expect(await cookieFor('http://192.168.1.20:8080')).not.toContain('Secure');
  });
});
