import { spawn } from 'node:child_process';

/**
 * Variables that would make Git work on another repository, read another configuration or
 * prompt: the daemon's Git commands never inherit them.
 */
const GIT_VARIABLES_REMOVED = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
];

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number,
    readonly stderr: string,
  ) {
    super(`git ${args[0] === '-C' ? (args[2] ?? '') : (args[0] ?? '')} failed: ${stderr.trim()}`);
  }
}

/** Runs `git` without a shell, never prompting (05, section 7). */
export class Git {
  readonly env: NodeJS.ProcessEnv;

  constructor(
    readonly file: string,
    env: NodeJS.ProcessEnv,
  ) {
    this.env = Object.fromEntries(
      Object.entries({ ...env, GIT_TERMINAL_PROMPT: '0' }).filter(
        ([name]) => !GIT_VARIABLES_REMOVED.includes(name),
      ),
    );
  }

  /** Resolves with the exit code and output, whatever the code. */
  exec(
    args: string[],
    extraEnv: Record<string, string> = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.file, args, {
        env: { ...this.env, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  }

  /** The standard output; throws `GitError` on a non-zero exit code. */
  async run(args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
    const result = await this.exec(args, extraEnv);
    if (result.code !== 0) throw new GitError(args, result.code, result.stderr);
    return result.stdout;
  }

  /** Whether `ref` exists in the repository at `folder`. */
  async hasRef(folder: string, ref: string): Promise<boolean> {
    return (await this.exec(['-C', folder, 'show-ref', '--verify', '--quiet', ref])).code === 0;
  }
}
