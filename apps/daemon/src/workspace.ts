import { mkdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  TEXT_CEILING,
  type BranchReport,
  type PushResult,
  type RunStart,
  type WorkspaceFacts,
} from '@orchestrator/protocol';
import type { Logger } from 'pino';
import type { CredentialSource } from './credentials.js';
import type { Git } from './git.js';
import { isolatedFetch, isolatedPush, type IsolatedGitOptions } from './isolated-git.js';
import type { DaemonPaths } from './paths.js';
import { RUN_MARKER } from './processes.js';
import type { TrustRegistry } from './trust.js';

// A run's Git workspace (05, section 4.2): one bare clone per repository, reused across runs,
// and one worktree per run on the ticket branch. The bare clone receives the remote's branches
// in `refs/remotes/origin/*`, so a fetch never overwrites a ticket branch holding commits not
// pushed yet. Fetches and pushes hold the credential and run in an isolated repository
// (`isolated-git.ts`), never reading the bare clone's configuration, which an agent can change;
// the bare clone's empty `credential.helper` keeps the owner's own helpers away from the agent's
// own Git commands.

type Repository = RunStart['payload']['repository'];

export interface WorkspaceOptions {
  paths: DaemonPaths;
  git: Git;
  trust: TrustRegistry;
  credentials: CredentialSource;
  selfCommand: readonly string[];
  log: Logger;
}

export function bareClonePath(paths: DaemonPaths, repository: Repository): string {
  return join(paths.home, 'repos', repository.owner, `${repository.name}.git`);
}

export function worktreePath(paths: DaemonPaths, runId: string): string {
  return join(paths.home, 'worktrees', runId);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export class Workspaces {
  /** One Git operation at a time per bare clone: two runs of a repository share it. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly options: WorkspaceOptions) {}

  private locked<T>(bare: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(bare) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.locks.set(
      bare,
      next.catch(() => undefined),
    );
    return next;
  }

  /**
   * Clones the repository if needed, fetches it, makes sure it is trusted, and creates the run's
   * worktree (or keeps it, for a resumed run). `runFolder` receives the credential socket.
   */
  async prepare(
    start: RunStart['payload'],
    runFolder: string,
  ): Promise<{ bare: string; worktree: string }> {
    const { git, paths } = this.options;
    const { repository } = start;
    const bare = bareClonePath(paths, repository);
    const worktree = worktreePath(paths, start.runId);
    const marker = { [RUN_MARKER]: start.runId };
    await this.locked(bare, async () => {
      if (!(await exists(join(bare, 'HEAD')))) await this.init(bare, repository.cloneUrl);
      // Every value replaced: an agent may have added more, which `remote set-url` refuses.
      else
        await git.run([
          '-C',
          bare,
          'config',
          '--replace-all',
          'remote.origin.url',
          repository.cloneUrl,
        ]);
      // An empty helper, holding no secret: the owner's global and system helpers (such as Git
      // Credential Manager on WSL) never answer for the agent's own Git commands in this
      // repository or its worktrees (05, section 7). Set at each preparation, so bare clones made
      // by 0.2.0 get it too.
      await git.run(['-C', bare, 'config', '--replace-all', 'credential.helper', '']);
      await isolatedFetch(this.isolated(start, runFolder), bare);
      if (await exists(worktree)) return;
      await mkdir(dirname(worktree), { recursive: true, mode: 0o700 });
      await git.run(['-C', bare, 'worktree', 'prune'], marker);
      const branch = repository.ticketBranch;
      if (await git.hasRef(bare, `refs/heads/${branch}`)) {
        await git.run(['-C', bare, 'worktree', 'add', worktree, branch], marker);
      } else {
        const from = (await git.hasRef(bare, `refs/remotes/origin/${branch}`))
          ? `origin/${branch}`
          : `origin/${repository.baseBranch}`;
        await git.run(
          ['-C', bare, 'worktree', 'add', '--no-track', '-b', branch, worktree, from],
          marker,
        );
      }
      // The commit author, for this worktree only (04, section 4).
      await git.run(['-C', worktree, 'config', '--worktree', 'user.name', start.commitAuthor.name]);
      await git.run([
        '-C',
        worktree,
        'config',
        '--worktree',
        'user.email',
        start.commitAuthor.email,
      ]);
    });
    await this.options.trust.ensure(bare);
    return { bare, worktree };
  }

  private async init(bare: string, cloneUrl: string): Promise<void> {
    const { git } = this.options;
    await mkdir(dirname(bare), { recursive: true, mode: 0o700 });
    try {
      await git.run(['init', '--quiet', '--bare', bare]);
      await git.run(['-C', bare, 'remote', 'add', 'origin', cloneUrl]);
      await git.run([
        '-C',
        bare,
        'config',
        'remote.origin.fetch',
        '+refs/heads/*:refs/remotes/origin/*',
      ]);
      // Per-worktree configuration for the commit author. Git then reads `core.bare` of the
      // shared configuration in every worktree, so it moves to the bare clone's own file.
      await git.run(['-C', bare, 'config', 'extensions.worktreeConfig', 'true']);
      await git.run(['-C', bare, 'config', '--unset', 'core.bare']);
      await git.run(['-C', bare, 'config', '--worktree', 'core.bare', 'true']);
    } catch (error) {
      await rm(bare, { recursive: true, force: true });
      throw error;
    }
  }

  /** What a credentialed command of this run needs (05, section 7). */
  private isolated(start: RunStart['payload'], runFolder: string): IsolatedGitOptions {
    const { repository } = start;
    return {
      git: this.options.git,
      folder: runFolder,
      cloneUrl: repository.cloneUrl,
      request: {
        runId: start.runId,
        repository: { owner: repository.owner, name: repository.name },
      },
      source: this.options.credentials,
      selfCommand: this.options.selfCommand,
      log: this.options.log,
      timeoutSeconds: start.limits.pushTimeoutSeconds,
    };
  }

  /**
   * Pushes `head`, the ticket branch's head as the caller read it once, to the ticket branch on
   * GitHub (05, section 4.9). Never throws: a failure is a result.
   */
  async push(
    start: RunStart['payload'],
    bare: string,
    runFolder: string,
    head: string,
  ): Promise<PushResult> {
    try {
      return await this.locked(bare, () =>
        isolatedPush(this.isolated(start, runFolder), bare, start.repository.ticketBranch, head),
      );
    } catch (error) {
      this.options.log.error({ err: error }, 'push not attempted');
      return {
        status: 'failed',
        reason: 'unreachable',
        message:
          `The push could not start: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            TEXT_CEILING,
          ),
      };
    }
  }

  /** The ticket branch's head and its commits ahead of the remote's base branch; null without it. */
  async branchReport(
    bare: string,
    repository: Pick<Repository, 'baseBranch' | 'ticketBranch'>,
  ): Promise<BranchReport | null> {
    const { git } = this.options;
    const branch = `refs/heads/${repository.ticketBranch}`;
    if (!(await git.hasRef(bare, branch))) return null;
    // Read once: the commits listed, the head reported and the hash pushed are this one.
    const head = (
      await git.run(['-C', bare, 'rev-parse', '--verify', `${branch}^{commit}`])
    ).trim();
    const base = `refs/remotes/origin/${repository.baseBranch}`;
    const range = (await git.hasRef(bare, base)) ? `${base}..${head}` : head;
    const log = await git.run(['-C', bare, 'log', '--format=%H%x00%s', range]);
    return {
      name: repository.ticketBranch,
      head,
      commitsAhead: log
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [hash = '', subject = ''] = line.split('\0');
          return { hash, subject: subject.slice(0, TEXT_CEILING) };
        }),
    };
  }

  /**
   * The worktree's facts for a `ticket_submit`, read now, never cached (05, section 4.9): clean
   * (no change, untracked files included), and the ticket branch's head, read once, and its
   * commits. `git status` is given the worktree's Git folder in the bare clone, never following
   * the worktree's `.git` file, which an agent can change.
   */
  async facts(
    bare: string,
    worktree: string,
    repository: Pick<Repository, 'baseBranch' | 'ticketBranch'>,
    runId: string,
  ): Promise<WorkspaceFacts | null> {
    const status = await this.options.git.run(
      [
        '--git-dir',
        join(bare, 'worktrees', basename(worktree)),
        '--work-tree',
        worktree,
        'status',
        '--porcelain',
        '--untracked-files=all',
      ],
      { [RUN_MARKER]: runId },
    );
    const branch = await this.branchReport(bare, repository);
    // The changed files are not collected before lot 3's step F; the push is added by the run.
    return branch ? { clean: status.trim() === '', branch, push: null, changedFiles: null } : null;
  }

  /** Removes the run's worktree; its branch stays in the bare clone (05, section 4.11). */
  async remove(bare: string, worktree: string): Promise<void> {
    const { git } = this.options;
    await this.locked(bare, async () => {
      if (await exists(worktree)) {
        const removed = await git.exec(['-C', bare, 'worktree', 'remove', '--force', worktree]);
        if (removed.code !== 0) {
          this.options.log.warn({ stderr: removed.stderr }, 'worktree not removed by Git: deleted');
        }
        await rm(worktree, { recursive: true, force: true });
      }
      await git.exec(['-C', bare, 'worktree', 'prune']);
    });
  }
}
