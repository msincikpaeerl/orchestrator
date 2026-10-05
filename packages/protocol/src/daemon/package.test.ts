import { describe, expect, it } from 'vitest';
import { DAEMON_PACKAGE_NAME, daemonPackageFileName, daemonUpdateCommands } from './package.js';

describe('daemon package', () => {
  it('is installed as orchestrator-daemon, not under the workspace name', () => {
    expect(DAEMON_PACKAGE_NAME).toBe('orchestrator-daemon');
    expect(daemonPackageFileName('0.4.0')).toBe('orchestrator-daemon-0.4.0.tgz');
  });

  it('gives the update commands that worked on 2026-10-03, for the server address', () => {
    expect(daemonUpdateCommands('http://192.168.1.20:8080/', '0.4.0')).toEqual([
      'systemctl --user stop orchestrator-daemon',
      'npm uninstall -g orchestrator-daemon',
      'npm install -g --prefer-online http://192.168.1.20:8080/downloads/orchestrator-daemon-0.4.0.tgz',
      'orchestrator-daemon install-service',
      'orchestrator-daemon doctor',
    ]);
  });
});
