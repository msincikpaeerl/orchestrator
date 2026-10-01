import { createHash, randomUUID } from 'node:crypto';
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

/** Longest systemd error kept in a reason, so a `doctor` message stays short. */
const REASON_MAX_LENGTH = 300;

/** What `UserSystemd.detect` found: the user's systemd, or why process scopes cannot be made. */
export type ScopeDetection =
  { systemd: UserSystemd; problem: null } | { systemd: null; problem: string };

export class UserSystemd {
  private constructor(
    private readonly systemdRun: string,
    private readonly systemctl: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly trueCommand: string,
  ) {}

  /**
   * The user's systemd, when it creates a throw-away scope for this environment (the service's
   * normal case; a daemon in a terminal of a systemd session too); otherwise why not (05, section
   * 2). `prefix` starts the throw-away scope's name (`unitPrefix`).
   */
  static async detect(
    toolPath: string,
    env: NodeJS.ProcessEnv,
    prefix: string,
  ): Promise<ScopeDetection> {
    const systemdRun = findExecutable('systemd-run', toolPath);
    const systemctl = findExecutable('systemctl', toolPath);
    if (!systemdRun || !systemctl) {
      return {
        systemd: null,
        problem: `${systemdRun ? 'systemctl' : 'systemd-run'} was not found in the daemon's PATH`,
      };
    }
    const systemd = new UserSystemd(
      systemdRun,
      systemctl,
      env,
      findExecutable('true', toolPath) ?? '/bin/true',
    );
    const problem = await systemd.checkScope(prefix);
    return problem === null ? { systemd, problem: null } : { systemd: null, problem };
  }

  /** Creates a throw-away scope running `true`: null when it worked, otherwise why not. */
  async checkScope(prefix: string): Promise<string | null> {
    const unit = `${prefix}orchestrator-scope-check-${randomUUID().slice(0, 8)}`;
    const answer = await runCommand(this.systemdRun, this.scopeArgs(unit, [this.trueCommand]), {
      env: this.env,
    });
    if (answer?.code === 0) return null;
    const said = answer ? answer.stderr.trim() || answer.stdout.trim() : '';
    const detail = said
      ? `: ${said.replace(/\s+/g, ' ').slice(0, REASON_MAX_LENGTH)}`
      : answer
        ? ` (exit code ${String(answer.code)})`
        : ' (it did not answer)';
    return `systemd-run --user --scope failed${detail}`;
  }

  /** `command` run inside a new transient scope `unit` (stopped with `stopScope`). */
  scopeCommand(unit: string, command: readonly string[]): string[] {
    return [this.systemdRun, ...this.scopeArgs(unit, command)];
  }

  private scopeArgs(unit: string, command: readonly string[]): string[] {
    return [
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
