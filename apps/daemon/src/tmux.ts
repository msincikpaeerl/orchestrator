import { spawn } from 'node:child_process';
import { TMUX_SOCKET_NAME } from './paths.js';
import type { UserSystemd } from './systemd.js';

/** The tmux session of a run (05, section 4.3). */
export function sessionName(runId: string): string {
  return `orch-${runId}`;
}

/**
 * The daemon's own tmux server, `tmux -L orchestrator` (05, section 4.3). Commands are argument
 * lists, never shell strings, and run without `TMUX`/`TMUX_PANE`, so tmux never reaches the
 * owner's own server when the daemon was started from inside tmux.
 */
export class Tmux {
  private readonly env: NodeJS.ProcessEnv;
  /** New sessions one at a time: the first one starts the server, in its scope. */
  private starting: Promise<unknown> = Promise.resolve();

  /**
   * `serverScope`: where a systemd user session runs, the server is started inside this transient
   * scope, outside the service's cgroup, so a restart of the service keeps it (05, section 2).
   */
  constructor(
    private readonly file: string,
    env: NodeJS.ProcessEnv,
    private readonly serverScope: { systemd: UserSystemd; unit: string } | null = null,
  ) {
    this.env = Object.fromEntries(
      Object.entries(env).filter(([name]) => name !== 'TMUX' && name !== 'TMUX_PANE'),
    );
  }

  private run(
    args: string[],
    input?: string,
    wrap: (command: string[]) => string[] = (command) => command,
  ): Promise<{ code: number; stderr: string }> {
    const [file, ...rest] = wrap([this.file, '-L', TMUX_SOCKET_NAME, ...args]);
    return new Promise((resolve, reject) => {
      const child = spawn(file ?? this.file, rest, {
        env: this.env,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({ code: code ?? 1, stderr });
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(input ?? '');
    });
  }

  private async check(
    args: string[],
    input?: string,
    wrap?: (command: string[]) => string[],
  ): Promise<void> {
    const result = await this.run(args, input, wrap);
    if (result.code !== 0) {
      throw new Error(`tmux ${args[0] ?? ''} failed: ${result.stderr.trim()}`);
    }
  }

  /**
   * Starts a detached session running `command` directly (no shell), in `cwd`, with `env` added
   * to the session's environment. `env` is the absolute path of `env`, used to unset `TMUX` and
   * `TMUX_PANE`, which tmux sets in every pane (05, section 4.3).
   */
  async newSession(options: {
    name: string;
    cwd: string;
    env: Record<string, string>;
    envCommand: string;
    command: string[];
  }): Promise<void> {
    const next = this.starting.then(() => this.startSession(options));
    this.starting = next.catch(() => undefined);
    await next;
  }

  /** Whether the daemon's tmux server runs. */
  async serverRunning(): Promise<boolean> {
    return (await this.run(['list-sessions'])).code === 0;
  }

  private async startSession(options: {
    name: string;
    cwd: string;
    env: Record<string, string>;
    envCommand: string;
    command: string[];
  }): Promise<void> {
    const scope = this.serverScope;
    const wrap =
      scope && !(await this.serverRunning())
        ? (command: string[]) => scope.systemd.scopeCommand(scope.unit, command)
        : undefined;
    const args = [
      'new-session',
      '-d',
      '-s',
      options.name,
      '-c',
      options.cwd,
      '-x',
      '200',
      '-y',
      '50',
      ...Object.entries(options.env).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
      '--',
      options.envCommand,
      '-u',
      'TMUX',
      '-u',
      'TMUX_PANE',
      ...options.command,
    ];
    try {
      await this.check(args, undefined, wrap);
    } catch (error) {
      if (!wrap) throw error;
      // The scope of a server that just exited may still be collected: once more, a moment later.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await this.check(args, undefined, (await this.serverRunning()) ? undefined : wrap);
    }
  }

  async hasSession(name: string): Promise<boolean> {
    return (await this.run(['has-session', '-t', `=${name}`])).code === 0;
  }

  /** Closes the session; nothing when it is already gone. */
  async killSession(name: string): Promise<void> {
    await this.run(['kill-session', '-t', `=${name}`]);
  }

  /**
   * Sends `text` as one message (05, section 4.4): loaded into a buffer of its own, pasted as a
   * bracketed paste, then Enter.
   */
  async paste(name: string, text: string): Promise<void> {
    await this.check(['load-buffer', '-b', name, '-'], text);
    await this.check(['paste-buffer', '-d', '-p', '-b', name, '-t', `=${name}:`]);
    await this.check(['send-keys', '-t', `=${name}:`, 'Enter']);
  }
}
