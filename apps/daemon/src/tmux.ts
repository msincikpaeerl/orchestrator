import { spawn } from 'node:child_process';
import { TMUX_SOCKET_NAME } from './paths.js';

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

  constructor(
    private readonly file: string,
    env: NodeJS.ProcessEnv,
  ) {
    this.env = Object.fromEntries(
      Object.entries(env).filter(([name]) => name !== 'TMUX' && name !== 'TMUX_PANE'),
    );
  }

  private run(args: string[], input?: string): Promise<{ code: number; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.file, ['-L', TMUX_SOCKET_NAME, ...args], {
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

  private async check(args: string[], input?: string): Promise<void> {
    const result = await this.run(args, input);
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
    await this.check([
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
    ]);
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
