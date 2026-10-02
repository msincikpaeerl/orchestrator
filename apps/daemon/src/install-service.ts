import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname } from 'node:path';
import { requireConfig } from './config.js';
import { probeControl } from './control.js';
import { detectWsl } from './detect.js';
import { findExecutable, runCommand } from './exec.js';
import { UserError } from './errors.js';
import { SERVICE_NAME, type DaemonPaths } from './paths.js';
import { servicePath, unitText } from './unit.js';

/**
 * `orchestrator-daemon install-service` (05, section 2): writes the systemd user unit with the
 * absolute paths of `node` and of the daemon's script and the terminal's PATH (filtered), enables
 * and (re)starts it, and turns lingering on.
 */
export async function installService(
  paths: DaemonPaths,
  script: string,
  out: (line: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await requireConfig(paths.config);
  const running = await probeControl(paths.controlSocket);
  if (running.kind === 'running' && running.status.mode === 'terminal') {
    throw new UserError(
      `A daemon is running in a terminal (process ${String(running.status.pid)}): stop it with Ctrl+C first, so the service can connect.`,
    );
  }
  const systemctl = findExecutable('systemctl', env.PATH);
  if (!systemctl) {
    throw new UserError(
      'systemctl was not found: this computer has no systemd. On WSL, see "Turn on systemd on WSL" in Help > Machines.',
    );
  }

  const path = servicePath(env.PATH, detectWsl(env));
  const text = unitText({
    node: process.execPath,
    script: await realpath(script),
    path,
    orchestratorHome: env.ORCHESTRATOR_HOME || undefined,
  });
  await mkdir(dirname(paths.unit), { recursive: true });
  await writeFile(paths.unit, text);
  out(`Service file written: ${paths.unit}`);
  out(`The service runs with Node.js ${process.execPath} and this PATH:`);
  out(`  ${path}`);
  out('After installing a tool or changing the Node.js version, type this command again.');

  for (const args of [
    ['--user', 'daemon-reload'],
    ['--user', 'enable', SERVICE_NAME],
    ['--user', 'restart', SERVICE_NAME],
  ]) {
    const result = await runCommand(systemctl, args, { env });
    if (result?.code !== 0) {
      throw new UserError(
        `"systemctl ${args.join(' ')}" failed: ${result?.stderr.trim() || 'no answer'}. Check that "systemctl --user is-system-running" answers "running" (Help > Machines > Turn on systemd on WSL).`,
      );
    }
  }
  out('The service is enabled and started.');

  // With the user's name: without it, loginctl looks for the terminal's login session, which a
  // WSL terminal does not have ("No such device or address").
  const user = userInfo().username;
  const loginctl = findExecutable('loginctl', env.PATH);
  const linger = loginctl ? await runCommand(loginctl, ['enable-linger', user], { env }) : null;
  if (linger?.code === 0) {
    out('Lingering is on: the service runs even when you are not logged in.');
  } else {
    const reason = linger ? linger.stderr.trim() || 'no message' : 'loginctl was not found';
    out(
      `Lingering could not be turned on (${reason}), so the service stops when you log out. Type: loginctl enable-linger ${user}`,
    );
    out('If it fails again, see "Lingering" in Help > Machines.');
  }
  out('Check it with "orchestrator-daemon status".');
}
