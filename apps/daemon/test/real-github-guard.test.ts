import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Git } from '../src/git.js';
import { isolatedFetch } from '../src/isolated-git.js';
import { REAL_GITHUB_BLOCKED_URL, takeRealGitHubAttempts } from './real-github-guard.js';
import {
  DAEMON_COMMAND,
  captureLogger,
  createTestHome,
  linkSystemTool,
  type TestHome,
} from './testing.js';

// Working rule 9: what a test that tries to reach the real GitHub gets. The root vitest.setup.ts
// installs the fetch guard in every test file and fails a test after it tried; here the attempts
// are taken by the test itself, so it can check them.

let home: TestHome;

beforeEach(async () => {
  home = await createTestHome();
  await linkSystemTool(home.bin, 'git');
});

afterEach(async () => {
  await home.remove();
});

describe('the real GitHub guard', () => {
  it('refuses fetch to github.com and its API, and records each attempt', async () => {
    await expect(fetch('https://api.github.com/user')).rejects.toThrow(
      'A test tried to reach api.github.com (working rule 9)',
    );
    await expect(
      fetch('https://github.com/octo-owner/shop/pulls', { method: 'POST' }),
    ).rejects.toThrow('working rule 9');
    expect(takeRealGitHubAttempts()).toEqual([
      'GET https://api.github.com/user',
      'POST https://github.com/octo-owner/shop/pulls',
    ]);
    // Other hosts are untouched: a closed local port gives fetch's own error.
    await expect(fetch('http://127.0.0.1:9/')).rejects.toThrow('fetch failed');
    expect(takeRealGitHubAttempts()).toEqual([]);
  });

  it('sends Git in a test home to a closed local port instead of github.com', async () => {
    const failure = await promisify(execFile)(
      join(home.bin, 'git'),
      ['ls-remote', 'https://github.com/octo-owner/shop.git'],
      { cwd: home.root, env: { ...home.env, GIT_TERMINAL_PROMPT: '0' } },
    ).then(
      () => 'reached',
      (error: unknown) => (error as { stderr: string }).stderr,
    );
    expect(failure).toContain(REAL_GITHUB_BLOCKED_URL);
    expect(failure).toMatch(/Failed to connect to 127\.0\.0\.1 port 9|Could not connect/);
  });

  it("sends the daemon's credentialed Git, which reads no test home configuration, to a dead proxy", async () => {
    const git = new Git(join(home.bin, 'git'), home.env);
    const bare = join(home.root, 'bare.git');
    await git.run(['init', '--quiet', '--bare', bare]);
    const folder = join(home.root, 'run');
    await mkdir(folder, { mode: 0o700 });
    let asked = 0;
    const failure = await isolatedFetch(
      {
        git,
        folder,
        cloneUrl: 'https://github.com/octo-owner/shop.git',
        request: {
          runId: '00000000-0000-4000-8000-000000000000',
          repository: { owner: 'octo-owner', name: 'shop' },
        },
        source: () => {
          asked++;
          return Promise.resolve({ ok: false, message: 'never asked' });
        },
        selfCommand: DAEMON_COMMAND,
        log: captureLogger().log,
        timeoutSeconds: 30,
      },
      bare,
    ).then(
      () => 'reached',
      (error: unknown) => String(error),
    );
    // Through the proxy at the closed port 9, whatever curl's wording: "Failed to connect to
    // github.com port 443 via 127.0.0.1" (curl 8.x of the development host) or "Failed to connect
    // to 127.0.0.1 port 9" (the CI runner's curl). Never a direct connection to github.com.
    expect(failure).toMatch(
      /Failed to connect to (?:github\.com port 443 via 127\.0\.0\.1|127\.0\.0\.1 port 9)\b/,
    );
    expect(asked).toBe(0);
  });
});
