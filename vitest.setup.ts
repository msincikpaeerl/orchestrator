import {
  installRealGitHubGuard,
  takeRealGitHubAttempts,
} from './apps/daemon/test/real-github-guard.js';
import { afterEach } from 'vitest';

// Runs before every test file of every package (vitest.config.ts): a test that tries to reach the
// real GitHub fails (working rule 9; apps/daemon/test/real-github-guard.ts).
installRealGitHubGuard();

afterEach(() => {
  const attempts = takeRealGitHubAttempts();
  if (attempts.length > 0) {
    throw new Error(
      `This test tried to reach the real GitHub (working rule 9): ${attempts.join(', ')}. ` +
        "Give the server the fake GitHub's url (githubApiUrl, gitBaseUrl).",
    );
  }
});
