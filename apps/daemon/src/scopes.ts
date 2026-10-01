import type { DoctorCheck } from '@orchestrator/protocol';

/** The `doctor` check of process scopes (05, section 8). */
export const PROCESS_SCOPES_CHECK = 'Process scopes';

/**
 * Whether this daemon may start sessions (05, sections 2 and 8). The service must start them in
 * process scopes, or the next restart of the service would stop them: without scopes it still
 * runs and connects, but reports an error and refuses `run.start` and `run.resume`. A daemon in a
 * terminal without scopes keeps the fallback and reports nothing. Either one switches to the same
 * error when a run's scope cannot be created later, until the daemon is restarted.
 */
export class ProcessScopes {
  private problemText: string | null;
  /** Called once, when the daemon switches to the error; the connection reports it at once. */
  onProblem: () => void = () => undefined;

  /**
   * `problem`: why the scope check at start failed, for the service; null when scopes work, or
   * for a daemon in a terminal, which keeps the fallback.
   */
  constructor(
    private readonly mode: 'service' | 'terminal',
    problem: string | null,
    private readonly link: string | null = null,
  ) {
    this.problemText = problem === null ? null : this.describe('cannot be created', problem);
  }

  /** What the error says, null while sessions may start. */
  get problem(): string | null {
    return this.problemText;
  }

  /** A run's scope could not be created: no session starts until the daemon is restarted. */
  fail(reason: string): void {
    if (this.problemText !== null) return;
    this.problemText = this.describe('could not be created for a run', reason);
    this.onProblem();
  }

  /** The check for `hello`, `doctor` and `status`; null for a terminal daemon without error. */
  check(): DoctorCheck | null {
    if (this.problemText !== null) {
      return {
        name: PROCESS_SCOPES_CHECK,
        status: 'error',
        message: this.problemText,
        link: this.link,
      };
    }
    if (this.mode === 'terminal') return null;
    return {
      name: PROCESS_SCOPES_CHECK,
      status: 'ok',
      message: "Used: agents' sessions keep running when the service restarts",
      link: null,
    };
  }

  private describe(what: string, reason: string): string {
    const [why, restart] =
      this.mode === 'service'
        ? [
            ", so a restart of the service would stop every agent's session",
            'restart the service: systemctl --user restart orchestrator-daemon',
          ]
        : ['', 'stop the daemon and start it again'];
    return `Process scopes ${what} (${reason})${why}: this machine takes no runs. Check that "systemd-run --user --scope true" works in a terminal, then ${restart}.`;
  }
}
