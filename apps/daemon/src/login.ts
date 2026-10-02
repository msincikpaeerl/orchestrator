import { spawn } from 'node:child_process';
import { chmod, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { findExecutable } from './exec.js';
import { UserError } from './errors.js';
import type { DaemonPaths } from './paths.js';
import { TrustRegistry } from './trust.js';

/**
 * `orchestrator-daemon login` (05, section 3.1): opens Claude Code once with the dedicated
 * configuration folder, so the owner logs in to the account runs use. Claude Code starts in an
 * empty folder of the daemon's own, trusted beforehand, wherever the command is typed: it asks no
 * trust question and loads no CLAUDE.md (owner's check, lot 2 step N). Never run by tests with
 * the real `claude` (working rule 10). Resolves with Claude Code's exit code.
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
  return new Promise((resolve, reject) => {
    const child = spawn(claude, [], {
      cwd: folder,
      stdio: 'inherit',
      env: { ...process.env, CLAUDE_CONFIG_DIR: paths.claudeConfig },
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      resolve(code ?? 1);
    });
  });
}
