import { spawn } from 'node:child_process';
import { chmod, mkdir } from 'node:fs/promises';
import { findExecutable } from './exec.js';
import { UserError } from './errors.js';
import type { DaemonPaths } from './paths.js';

/**
 * `orchestrator-daemon login` (05, section 3.1): opens Claude Code once with the dedicated
 * configuration folder, so the owner logs in to the account runs use. Never run by tests with
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
  out(
    'Claude Code opens with a configuration kept only for the Orchestrator. Log in with the Claude account of this machine, then type /exit.',
  );
  return new Promise((resolve, reject) => {
    const child = spawn(claude, [], {
      stdio: 'inherit',
      env: { ...process.env, CLAUDE_CONFIG_DIR: paths.claudeConfig },
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      resolve(code ?? 1);
    });
  });
}
