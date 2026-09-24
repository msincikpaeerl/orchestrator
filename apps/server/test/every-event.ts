import { Project } from '@orchestrator/protocol';
import { expect } from 'vitest';
import { markTokenInvalid, markTokenUnreadable } from '../src/github/connection.js';
import { resetPassword } from '../src/reset-password.js';
import { fullAccount, type FakeGitHub } from './fake-github.js';
import { createOwner, OWNER, startTestApp, type TestApp } from './helpers.js';

const TOKEN = 'github_pat_11AAAAAAA0secretTokenValue1234567890';

/** The application with every setting the scenario needs; login throttling starts at once. */
export function startEveryEventApp(github: FakeGitHub): Promise<TestApp> {
  return startTestApp({ githubApiUrl: github.url, settings: { loginFailuresBeforeDelay: 1 } });
}

/**
 * Writes every event type of lots 0 and 1 through the code that writes them in production: the
 * API where the owner causes it, the server functions otherwise. Two projects (`SHOP`, created,
 * and `LEG`, linked) with tickets `SHOP-1` and `SHOP-2`. Ends with the password reset, which
 * revokes every session.
 */
export async function writeEveryEvent(t: TestApp, github: FakeGitHub): Promise<void> {
  const cookie = await createOwner(t.app);
  async function call(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) {
    const response = await t.app.inject({ method, url, headers: { cookie }, payload });
    expect(response.statusCode, `${method} ${url}: ${response.body}`).toBeLessThan(300);
    return response;
  }
  async function settled(key: string) {
    for (let i = 0; i < 200; i++) {
      const project = Project.parse((await call('GET', `/api/projects/${key}`)).json());
      if (project.setup.status !== 'in_progress') return project;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`setup of ${key} did not finish`);
  }

  github.accounts.set(
    TOKEN,
    fullAccount({
      repositories: [{ name: 'legacy', private: false, files: { 'README.md': '#' } }],
    }),
  );
  await call('PUT', '/api/github/token', { token: TOKEN, expiresOn: null });

  // A new public repository whose ruleset the token may not apply, then tried again.
  github.override = (request) =>
    request.method === 'POST' && request.path.endsWith('/rulesets')
      ? {
          status: 403,
          body: { message: 'Resource not accessible by personal access token' },
          headers: { 'x-accepted-github-permissions': 'administration=write' },
        }
      : undefined;
  await call('POST', '/api/projects', {
    name: 'Online Shop',
    key: 'SHOP',
    kind: 'web_app',
    repository: { origin: 'created', name: 'online-shop', private: false },
  });
  expect((await settled('SHOP')).setup.status).toBe('failed');
  github.override = undefined;
  await call('POST', '/api/projects/SHOP/setup/retry');
  expect((await settled('SHOP')).setup.status).toBe('ready');
  await call('PATCH', '/api/projects/SHOP', { name: 'Online <b>Shop</b>' });

  await call('POST', '/api/projects', {
    name: 'Legacy',
    key: 'LEG',
    kind: 'website',
    repository: { origin: 'linked', name: 'legacy' },
  });
  expect((await settled('LEG')).setup.status).toBe('ready');
  await call('POST', '/api/projects/LEG/harness/check');

  await call('POST', '/api/projects/SHOP/tickets', { type: 'feature', title: 'Cart' });
  await call('POST', '/api/projects/SHOP/tickets', { type: 'bug', title: 'Checkout' });
  await call('PATCH', '/api/projects/SHOP/tickets/2', { title: 'Checkout **fails**' });
  await call('POST', '/api/projects/SHOP/tickets/2/dependencies', { blockedBy: 1 });
  await call('DELETE', '/api/projects/SHOP/tickets/2/dependencies/1');
  await call('POST', '/api/projects/SHOP/tickets/1/comments', { body: 'Looks *good*' });
  await call('POST', '/api/projects/SHOP/tickets/1/mark-done', { comment: 'Done by hand' });

  await call('PUT', '/api/settings/sessionLifetimeDays', { value: 7 });
  await call('DELETE', '/api/settings/sessionLifetimeDays');
  await call('PUT', '/api/projects/SHOP/settings/ciWaitTimeoutMinutes', { value: 30 });
  await call('DELETE', '/api/projects/SHOP/settings/ciWaitTimeoutMinutes');

  await call('POST', '/api/projects/LEG/archive');
  await call('POST', '/api/projects/LEG/unarchive');

  await markTokenInvalid(t.db, 'system', 'GET /user');
  await markTokenUnreadable(t.db);
  await call('POST', '/api/auth/logout');
  const failed = await t.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: OWNER.username, password: 'wrong password!' },
  });
  expect(failed.statusCode).toBe(401);
  await resetPassword(t.db, 'another correct horse battery');
}
