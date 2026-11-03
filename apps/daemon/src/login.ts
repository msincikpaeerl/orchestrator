import { spawn } from 'node:child_process';
import { chmod, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { clearLoginExpired } from './claude-login.js';
import { requestRecheck } from './control.js';
import { findExecutable } from './exec.js';
import { UserError } from './errors.js';
import type { DaemonPaths } from './paths.js';
import { TrustRegistry } from './trust.js';

/**
 * `orchestrator-daemon login` (05, section 3.1): opens Claude Code once with the dedicated
 * configuration folder, so the owner logs in to the account runs use. Claude Code starts in an
 * empty folder of the daemon's own, trusted beforehand, wherever the command is typed: it asks no
 * trust question and loads no CLAUDE.md (owner's check, lot 2 step N). Never run by tests with
 * the real `claude` (working rule 10). Resolves with Claude Code's exit code; once it is 0, the
 * running daemon checks the machine again (an expired login, lot 5 step M2b).
 */
export async function login(paths: DaemonPaths, out: (line: string) => void): Promise<number> {
  const claude = findExecutable('claude', process.env.PATH);
  if (!claude) {
    throw new UserError(
      'Claude Code (claude) is not installed, or not in this terminal\'s PATH: see "Before you start" in Help > Machines.',
    );
  }
  await mkdir(paths.claudeConfig, { recursive: true, mode: 0o700 });
  await chmod(paths.home, 0o700);
  await mkdir(paths.loginFolder, { recursive: true, mode: 0o700 });
  const folder = await realpath(paths.loginFolder);
  await new TrustRegistry(join(paths.claudeConfig, '.claude.json')).ensure(folder);
  out(
    'Claude Code opens with a configuration kept only for the Orchestrator. Log in with the Claude account of this machine, then type /exit.',
  );
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(claude, [], {
      cwd: folder,
      stdio: 'inherit',
      env: { ...process.env, CLAUDE_CONFIG_DIR: paths.claudeConfig },
    });
    child.on('error', reject);
    child.on('exit', (exitCode) => {
      resolve(exitCode ?? 1);
    });
  });
  if (code === 0) await afterLogin(paths, out);
  return code;
}

/**
 * Claude Code exited normally: the marker of an expired login goes, and the running daemon sends
 * its checks again, so the machine takes runs again at once (05, section 3.1; lot 5 step M2b).
 */
async function afterLogin(paths: DaemonPaths, out: (line: string) => void): Promise<void> {
  clearLoginExpired(paths);
  const sent = await requestRecheck(paths.controlSocket);
  out(
    sent === true
      ? 'The daemon checked this machine again and told the Orchestrator: it takes runs once every check passes.'
      : sent === false
        ? 'The daemon checked this machine again: the Orchestrator hears it when the daemon connects.'
        : 'The daemon is not running: it checks this machine when it starts.',
  );
}
