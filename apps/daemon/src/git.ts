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
  'XDG_CONFIG_HOME',
];

/**
 * A home folder the owner's user cannot create: Git and libcurl read no `~/.gitconfig`,
 * `~/.config/git/config`, `~/.netrc` or `~/.git-credentials`, which an agent can write (05,
 * section 7).
 */
export const NO_HOME = '/nonexistent';

/**
 * The environment every Git command of the daemon starts from: no global or system configuration
 * (an agent can change the owner's global configuration), nothing read from the owner's home.
 */
export const GIT_ISOLATION_ENV = {
  HOME: NO_HOME,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

/**
 * Options of every local Git command of the daemon, in the bare clones and the worktrees an agent
 * can change: no hook, no file system monitor, no automatic maintenance, so a program named in
 * that configuration does not start from the daemon, outside the run's process scope (05,
 * section 7). Filters and other programs named in the repository's configuration stay a known
 * limit.
 */
export const LOCAL_GIT_OPTIONS = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
];

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number,
    readonly stderr: string,
  ) {
    super(`git ${subcommand(args)} failed: ${stderr.trim()}`);
  }
}

/** The Git subcommand of `args`, after the options before it. */
function subcommand(args: string[]): string {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? '';
    if (arg === '-C' || arg === '-c') index++;
    else if (!arg.startsWith('-')) return arg;
  }
  return '';
}

/**
 * Runs `git` without a shell, never prompting, with the options and environment above (05,
 * section 7). Commands holding a credential use `isolated-git.ts` instead.
 */
export class Git {
  readonly env: NodeJS.ProcessEnv;

  constructor(
    readonly file: string,
    env: NodeJS.ProcessEnv,
  ) {
    this.env = {
      ...Object.fromEntries(
        Object.entries(env).filter(([name]) => !GIT_VARIABLES_REMOVED.includes(name)),
      ),
      ...GIT_ISOLATION_ENV,
    };
  }

  /** Resolves with the exit code and output, whatever the code. `input` goes to standard input. */
  exec(
    args: string[],
    extraEnv: Record<string, string> = {},
    input?: string,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.file, [...LOCAL_GIT_OPTIONS, ...args], {
        env: { ...this.env, ...extraEnv },
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
      if (input !== undefined) child.stdin?.end(input);
      let stdout = '';
      let stderr = '';
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  }

  /** The standard output; throws `GitError` on a non-zero exit code. */
  async run(
    args: string[],
    extraEnv: Record<string, string> = {},
    input?: string,
  ): Promise<string> {
    const result = await this.exec(args, extraEnv, input);
    if (result.code !== 0) throw new GitError(args, result.code, result.stderr);
    return result.stdout;
  }

  /** Whether `ref` exists in the repository at `folder`. */
  async hasRef(folder: string, ref: string): Promise<boolean> {
    return (await this.exec(['-C', folder, 'show-ref', '--verify', '--quiet', ref])).code === 0;
  }
}
