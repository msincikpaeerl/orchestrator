import { describe, expect, it } from 'vitest';
import { profileLines } from './allowlist-smoke-profiles.js';

const scope = { daemonHome: '/home/owner/.orchestrator', userHome: '/home/owner' };

describe('profiles the allowlist smoke test runs', () => {
  it('names the earlier profile with the same rules, whatever their order', () => {
    expect(
      profileLines(scope, [
        { key: 'architect', allowedTools: ['Read', 'Bash(git status)'] },
        { key: 'designer', allowedTools: ['Read'] },
        { key: 'web_dev', allowedTools: ['Bash(git status)', 'Read'] },
      ]),
    ).toBe('architect\ndesigner\nweb_dev architect\n');
  });

  it('runs every profile whose allowlist differs', () => {
    expect(
      profileLines(scope, [
        { key: 'architect', allowedTools: ['Read'] },
        { key: 'web_dev', allowedTools: ['Read', 'Bash(pnpm *)'] },
      ]),
    ).toBe('architect\nweb_dev\n');
  });
});
