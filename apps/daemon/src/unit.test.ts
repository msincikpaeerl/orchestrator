import { describe, expect, it } from 'vitest';
import { EXIT_REFUSED } from './errors.js';
import { parseUnit, servicePath, unitText } from './unit.js';

describe('the service PATH (05, section 2)', () => {
  it('drops empty and relative entries and duplicates', () => {
    expect(servicePath('/a/bin::.:bin:/usr/bin:/a/bin:./x', false)).toBe('/a/bin:/usr/bin');
  });

  it('drops the Windows folders under /mnt/ on WSL only', () => {
    const path = '/home/o/.local/bin:/mnt/c/Windows/system32:/mnt/c/Program Files/Git/cmd:/usr/bin';
    expect(servicePath(path, true)).toBe('/home/o/.local/bin:/usr/bin');
    expect(servicePath(path, false)).toBe(path);
  });
});

describe('the unit file', () => {
  const values = {
    node: '/home/o/.nvm/versions/node/v24.21.0/bin/node',
    script:
      '/home/o/.nvm/versions/node/v24.21.0/lib/node_modules/orchestrator-daemon/dist/orchestrator-daemon.js',
    path: '/home/o/.local/bin:/usr/bin',
    orchestratorHome: undefined,
  };

  it('starts the absolute node and script, and is not restarted after a refusal', () => {
    const text = unitText(values);
    expect(text).toContain(`ExecStart="${values.node}" "${values.script}" start --service`);
    expect(text).toContain(`Environment="PATH=${values.path}"`);
    expect(text).toContain(`RestartPreventExitStatus=${String(EXIT_REFUSED)}`);
    expect(text).toContain('Restart=on-failure');
    expect(text).toContain('WantedBy=default.target');
    expect(text).not.toContain('ORCHESTRATOR_HOME');
  });

  it('reads back what it wrote, with specifiers and quotes escaped', () => {
    const odd = {
      ...values,
      node: '/opt/n%de "x"/node',
      path: '/a%b:/c',
      orchestratorHome: '/tmp/h',
    };
    const text = unitText(odd);
    expect(text).toContain('%%');
    expect(text).toContain('Environment="ORCHESTRATOR_HOME=/tmp/h"');
    expect(parseUnit(text)).toEqual({ node: odd.node, path: odd.path });
  });

  it('reads a unit without the values as nulls', () => {
    expect(parseUnit('[Service]\nType=simple\n')).toEqual({ node: null, path: null });
  });
});
