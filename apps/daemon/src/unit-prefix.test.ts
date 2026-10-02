import { userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { daemonPaths } from './paths.js';
import { runScopeName, tmuxScopeName, unitPrefix } from './systemd.js';

// Unit names of the owner's daemon and of the tests' daemons (05, section 2): a test must never
// create, reuse or stop a unit named like the owner's.

const home = process.env.HOME;
afterEach(() => {
  process.env.HOME = home;
});

describe('unitPrefix', () => {
  it("is empty for the daemon's folder in the user's home folder", () => {
    const { homedir } = userInfo();
    const paths = daemonPaths({ HOME: homedir, ORCHESTRATOR_HOME: join(homedir, '.orchestrator') });
    expect(unitPrefix(paths)).toBe('');
    expect(tmuxScopeName(unitPrefix(paths))).toBe('orchestrator-tmux');
  });

  it('starts with od-test- for a test home, even when HOME is the test home', () => {
    // As the systemd test starts its service: HOME and ORCHESTRATOR_HOME in the test home.
    const testHome = '/tmp/od-test-AbCdEf/home';
    const env = { HOME: testHome, ORCHESTRATOR_HOME: join(testHome, '.orchestrator') };
    process.env.HOME = testHome;
    const prefix = unitPrefix(daemonPaths(env));
    expect(prefix).toMatch(/^od-test-[0-9a-f]{8}-$/);
    expect(tmuxScopeName(prefix)).not.toBe('orchestrator-tmux');
    expect(runScopeName(prefix, 'run')).toBe(`${prefix}orch-run-run`);
  });
});
