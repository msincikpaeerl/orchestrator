// Working rule 9: no test ever reaches the real GitHub. Tests use the fake GitHub
// (apps/server/test/fake-github.ts); these guards make a test that tries anyway fail, naming what
// it tried, instead of reaching github.com with whatever credential it holds.
//
// - `fetch` (the server's GitHub client and any test code): `installRealGitHubGuard` refuses
//   requests to github.com, its subdomains (api.github.com) and githubusercontent.com, and
//   records them; the root `vitest.setup.ts` installs it in every test file and fails the test
//   after it, so a refusal the code under test catches (as "GitHub unreachable") still fails it.
// - Git (the daemon's clones and pushes, a test's own commands): every test home's Git
//   configuration (`createTestHome`) rewrites github.com URLs to `REAL_GITHUB_BLOCKED_URL`, a
//   closed local port, so Git fails with "Failed to connect to 127.0.0.1 port 9" and the URL
//   names the reason.

/** Where Git sends github.com URLs in a test home: nothing listens on port 9. */
export const REAL_GITHUB_BLOCKED_URL = 'http://127.0.0.1:9/a-test-tried-to-reach-github.com/';

/** The Git configuration of a test home: every github.com address goes to the closed port. */
export const REAL_GITHUB_GIT_CONFIG = [
  `[url "${REAL_GITHUB_BLOCKED_URL}"]`,
  ...['https://github.com/', 'http://github.com/', 'git@github.com:', 'ssh://git@github.com/'].map(
    (prefix) => `\tinsteadOf = ${prefix}`,
  ),
  '',
].join('\n');

const REAL_GITHUB_HOST = /(^|\.)(github\.com|githubusercontent\.com)$/i;

const attempts: string[] = [];
let installed = false;

export function isRealGitHubHost(hostname: string): boolean {
  return REAL_GITHUB_HOST.test(hostname);
}

/** Makes `fetch` refuse the real GitHub in this process. */
export function installRealGitHubGuard(): void {
  if (installed) return;
  installed = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (isRealGitHubHost(target.hostname)) {
      attempts.push(`${init?.method ?? 'GET'} ${target.origin}${target.pathname}`);
      return Promise.reject(
        new TypeError(
          `A test tried to reach ${target.hostname} (working rule 9): use the fake GitHub.`,
        ),
      );
    }
    return realFetch(input, init);
  };
}

/** The requests refused since the last call, which it forgets. */
export function takeRealGitHubAttempts(): string[] {
  return attempts.splice(0);
}
