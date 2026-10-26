import { join } from 'node:path';
import { nodeCommand } from '../fake-claude/install.js';
import { fakeExecutable } from '../testing.js';

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/**
 * Writes the fake `systemd-run` of this folder in `bin`, saying `version` (systemd 254 and later
 * expand a scope's command), and a `systemctl` that succeeds: the normal test run's scopes.
 */
export async function installFakeSystemd(bin: string, version = 259): Promise<void> {
  const [node = '', tsx = ''] = nodeCommand('install.ts');
  const script = join(import.meta.dirname, 'systemd-run.ts');
  await fakeExecutable(
    bin,
    'systemd-run',
    `FAKE_SYSTEMD_VERSION=${String(version)} exec ${[node, tsx, script].map(quote).join(' ')} "$@"`,
  );
  await fakeExecutable(bin, 'systemctl', 'exit 0');
}
