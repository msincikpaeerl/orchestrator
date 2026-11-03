import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DoctorCheck } from '@orchestrator/protocol';
import { findExecutable, runCommand } from './exec.js';
import type { DaemonPaths } from './paths.js';

// The machine's Claude Code login (05, sections 4.10 and 8; lot 5 step M2b). Claude Code cannot
// tell an expired login from a working one without starting a session: `claude auth status`
// answers `loggedIn: false` only when no login is there (owner's check, Claude Code 2.1.317). So
// a run that meets Claude Code's login error writes a marker, and the machine takes no runs until
// `orchestrator-daemon login` removes it. The login file itself is never read.

export const LOGIN_CHECK = 'Claude Code login';

export const LOGGED_OUT =
  'Claude Code is logged out on this machine: type "orchestrator-daemon login" and log in with the Claude account of this machine.';

const NOT_LOGGED_IN =
  'Not logged in: type "orchestrator-daemon login" and log in with the Claude account of this machine.';

/** What Claude Code cannot say, after an ok: the guard is the marker of a run. */
const CANNOT_TELL =
  'Claude Code does not say whether the login is still valid without starting a session. A run that finds it expired marks this machine unusable.';

/** The marker of an expired login, written by a run (05, section 4.10). */
export class ClaudeLogin {
  /** Called when a run marks the login expired: the connection reports the checks at once. */
  onExpired: () => void = () => undefined;

  constructor(private readonly file: string) {}

  get expired(): boolean {
    return existsSync(this.file);
  }

  /** Writes the marker (the time only, no secret) and tells the connection. */
  markExpired(): void {
    writeFileSync(this.file, `${JSON.stringify({ at: new Date().toISOString() })}\n`, {
      mode: 0o600,
    });
    this.onExpired();
  }
}

/** Removes the marker: `orchestrator-daemon login` once Claude Code exits normally. */
export function clearLoginExpired(paths: DaemonPaths): void {
  rmSync(paths.loginExpired, { force: true });
}

/**
 * `loggedIn` of `claude auth status` in the dedicated configuration folder, and nothing else it
 * prints (its other fields name the account): null when it gives no answer the daemon can read,
 * such as a Claude Code without the command.
 */
export async function authStatus(
  claude: string,
  paths: DaemonPaths,
  toolPath: string,
): Promise<boolean | null> {
  const result = await runCommand(claude, ['auth', 'status'], {
    env: { ...process.env, PATH: toolPath, CLAUDE_CONFIG_DIR: paths.claudeConfig },
  });
  if (!result) return null;
  let answer: unknown;
  try {
    answer = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (typeof answer !== 'object' || answer === null || !('loggedIn' in answer)) return null;
  const { loggedIn } = answer;
  return typeof loggedIn === 'boolean' ? loggedIn : null;
}

/**
 * The "Claude Code login" check (05, section 8): an error while the marker of an expired login
 * exists or `claude auth status` says no login is there; otherwise ok, saying what Claude Code
 * cannot tell. When `auth status` gives no readable answer, the login file's presence decides.
 */
export async function loginCheck(paths: DaemonPaths, toolPath: string): Promise<DoctorCheck> {
  const check = (status: DoctorCheck['status'], message: string): DoctorCheck => ({
    name: LOGIN_CHECK,
    status,
    message,
    link: null,
  });
  if (existsSync(paths.loginExpired)) return check('error', LOGGED_OUT);
  const claude = findExecutable('claude', toolPath);
  const loggedIn = claude ? await authStatus(claude, paths, toolPath) : null;
  if (loggedIn === true) return check('ok', `Logged in. ${CANNOT_TELL}`);
  if (loggedIn === false) return check('error', NOT_LOGGED_IN);
  return existsSync(join(paths.claudeConfig, '.credentials.json'))
    ? check('ok', `Login file found: ${CANNOT_TELL}`)
    : check('error', NOT_LOGGED_IN);
}
