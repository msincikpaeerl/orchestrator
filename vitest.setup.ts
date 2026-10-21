import {
  installRealGitHubGuard,
  takeRealGitHubAttempts,
} from './apps/daemon/test/real-github-guard.js';
import { TestRunner, afterEach, vi } from 'vitest';

// Runs before every test file of every package (vitest.config.ts): a test that tries to reach the
// real GitHub fails (working rule 9; apps/daemon/test/real-github-guard.ts).
installRealGitHubGuard();

// Integration tests (a package's `test/` folder) start servers, databases, Git, tmux and the daemon
// from its sources: under load, as on GitHub's runners, they ran up to 9.9 seconds where they take
// 1.4 alone, over Vitest's 5 (lot 4, step H's record). They get 20 seconds by default; unit tests
// next to the code keep Vitest's 5. Set before the test file is read, which fixes each test's
// timeout; Vitest resets it after each file.
const INTEGRATION_TEST_TIMEOUT_MS = 20_000;
if (
  /[\\/](?:apps|packages)[\\/][^\\/]+[\\/]test[\\/]/.test(
    TestRunner.getCurrentSuite().file.filepath,
  )
) {
  vi.setConfig({ testTimeout: INTEGRATION_TEST_TIMEOUT_MS });
}

afterEach(() => {
  const attempts = takeRealGitHubAttempts();
  if (attempts.length > 0) {
    throw new Error(
      `This test tried to reach the real GitHub (working rule 9): ${attempts.join(', ')}. ` +
        "Give the server the fake GitHub's url (githubApiUrl, gitBaseUrl).",
    );
  }
});
