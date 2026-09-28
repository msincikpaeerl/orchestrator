import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { findExecutable, runCommand } from './exec.js';
import { SWEEP_GRACE_MS } from './processes.js';
import type { DaemonPaths } from './paths.js';

// Transient systemd scopes of the user's session (05, sections 2 and 4.3; lot 2 plan step K).
// Where a systemd user session runs, the tmux server lives in a scope of its own, outside the
// service's cgroup, so restarting the service keeps the agents' sessions; and each run's Claude
// Code in a scope of its own, so closing the run ends every process in it, whatever it did to its
// session or process group. Without a systemd user session nothing changes.

/**
 * What unit names start with: nothing for the daemon's own folder; for any other folder (the
 * tests' throw-away homes), `od-test-` and a hash of it, so a test never meets the owner's units
 * and its leftovers are found by that prefix.
 */
export function unitPrefix(paths: DaemonPaths): string {
  if (resolve(paths.home) === resolve(join(homedir(), '.orchestrator'))) return '';
  return `od-test-${createHash('sha256').update(resolve(paths.home)).digest('hex').slice(0, 8)}-`;
}

/** The scope of the daemon's tmux server. */
export function tmuxScopeName(prefix: string): string {
  return `${prefix}orchestrator-tmux`;
}

/** The scope of one run's Claude Code. */
export function runScopeName(prefix: string, runId: string): string {
  return `${prefix}orch-run-${runId}`;
}

export class UserSystemd {
  private constructor(
    private readonly systemdRun: string,
    private readonly systemctl: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  /**
   * The user's systemd when it answers to this environment (the service has it; a daemon in a
   * terminal of a systemd session too); null otherwise.
   */
  static async detect(toolPath: string, env: NodeJS.ProcessEnv): Promise<UserSystemd | null> {
    const systemdRun = findExecutable('systemd-run', toolPath);
    const systemctl = findExecutable('systemctl', toolPath);
    if (!systemdRun || !systemctl) return null;
    const answer = await runCommand(systemctl, ['--user', 'show-environment'], {
      env,
      timeoutMs: 5000,
    });
    return answer?.code === 0 ? new UserSystemd(systemdRun, systemctl, env) : null;
  }

  /** `command` run inside a new transient scope `unit` (stopped with `stopScope`). */
  scopeCommand(unit: string, command: readonly string[]): string[] {
    return [
      this.systemdRun,
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      `--property=TimeoutStopSec=${String(Math.ceil(SWEEP_GRACE_MS / 1000))}s`,
      '--unit',
      unit,
      '--',
      ...command,
    ];
  }

  /** Stops the scope and every process in it; nothing when it does not exist. */
  async stopScope(unit: string): Promise<void> {
    await runCommand(this.systemctl, ['--user', 'stop', `${unit}.scope`], {
      env: this.env,
      timeoutMs: SWEEP_GRACE_MS + 10_000,
    });
  }

  /** Whether the unit is active, for `status` and the tests. */
  async isActive(unit: string): Promise<boolean> {
    const answer = await runCommand(this.systemctl, ['--user', 'is-active', unit], {
      env: this.env,
    });
    return answer?.stdout.trim() === 'active';
  }
}
