import { schema } from '@orchestrator/db';
import { ApiError } from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWNER, createOwner, startTestApp, type TestApp } from './helpers.js';

// Small thresholds so each rule shows in a few attempts.
const settings = {
  loginFailuresBeforeDelay: 3,
  loginFirstDelaySeconds: 10,
  loginMaxDelaySeconds: 40,
  loginFailureMemoryMinutes: 60,
};

let t: TestApp;
let clock: Date;

function advance(seconds: number) {
  clock = new Date(clock.getTime() + seconds * 1000);
}

beforeEach(async () => {
  clock = new Date('2026-09-23T12:00:00Z');
  t = await startTestApp({ settings, now: () => clock });
  await createOwner(t.app);
});

afterEach(async () => {
  await t.close();
});

function login(password: string, options: { username?: string; address?: string } = {}) {
  return t.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    remoteAddress: options.address ?? '192.168.1.50',
    payload: { username: options.username ?? OWNER.username, password },
  });
}

async function fail(times: number, options: { username?: string; address?: string } = {}) {
  for (let attempt = 0; attempt < times; attempt++) {
    expect((await login('wrong password!', options)).statusCode).toBe(401);
  }
}

function expectWait(response: Awaited<ReturnType<typeof login>>, seconds: number) {
  expect(response.statusCode).toBe(429);
  expect(response.headers['retry-after']).toBe(String(seconds));
  expect(ApiError.parse(response.json()).error).toMatchObject({
    code: 'too_many_attempts',
    retryAfterSeconds: seconds,
  });
}

describe('login throttling', () => {
  it('allows the configured failures, then makes even the right password wait', async () => {
    await fail(2);
    expect((await login('wrong password!')).statusCode).toBe(401); // third failure starts the delay
    expectWait(await login(OWNER.password), 10);

    advance(10);
    expect((await login(OWNER.password)).statusCode).toBe(200);
  });

  it('doubles the delay with each further failure, up to the maximum', async () => {
    await fail(3);
    const delays: number[] = [];
    for (let round = 0; round < 3; round++) {
      const waiting = await login('wrong password!');
      const wait = Number(waiting.headers['retry-after']);
      delays.push(wait);
      advance(wait);
      expect((await login('wrong password!')).statusCode).toBe(401);
    }
    expect(delays).toEqual([10, 20, 40]);
    expectWait(await login(OWNER.password), 40);
  });

  it('throttles an address trying several usernames', async () => {
    await fail(1, { username: 'admin' });
    await fail(1, { username: 'root' });
    await fail(1, { username: 'owner2' });
    expectWait(await login(OWNER.password), 10);
  });

  it('throttles a username attacked from several addresses', async () => {
    await fail(1, { address: '10.0.0.1' });
    await fail(1, { address: '10.0.0.2' });
    await fail(1, { address: '10.0.0.3' });
    expectWait(await login(OWNER.password, { address: '10.0.0.4' }), 10);
  });

  it('forgets failures after a successful login', async () => {
    await fail(2);
    expect((await login(OWNER.password)).statusCode).toBe(200);
    await fail(2);
    expect((await login(OWNER.password)).statusCode).toBe(200);
  });

  it('forgets failures older than the memory setting', async () => {
    await fail(2);
    advance(61 * 60);
    await fail(2);
    expect((await login(OWNER.password)).statusCode).toBe(200);
  });

  it('records an event when a delay starts, without the typed username', async () => {
    await fail(3, { username: 'my secret password' });
    const events = await t.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.type, 'owner.login_throttled'));
    expect(events.map((event) => event.payload)).toEqual([
      { scope: 'username', failures: 3, delaySeconds: 10 },
      { scope: 'address', address: '192.168.1.50', failures: 3, delaySeconds: 10 },
    ]);
    expect(JSON.stringify(events)).not.toContain('my secret password');
  });

  it('does not check the password during the delay', async () => {
    await fail(3);
    await login('wrong password!');
    await login('wrong password!');
    const [row] = await t.db
      .select()
      .from(schema.loginFailures)
      .where(eq(schema.loginFailures.key, 'address:192.168.1.50'));
    expect(row?.failures).toBe(3);
  });
});
