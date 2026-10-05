import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  TEXT_CEILING,
  type BranchReport,
  type RunStart,
  type WorkspaceFacts,
} from '@orchestrator/protocol';
import type { Logger } from 'pino';
import { withCredentialHelper, type CredentialSource } from './credentials.js';
import type { Git } from './git.js';
import type { DaemonPaths } from './paths.js';
import type { TrustRegistry } from './trust.js';

// A run's Git workspace (05, section 4.2): one bare clone per repository, reused across runs,
// and one worktree per run on the ticket branch. The bare clone fetches the remote's branches
// into `refs/remotes/origin/*`, so a fetch never overwrites a ticket branch holding commits not
// pushed yet; its configuration never holds a credential, and its empty `credential.helper` keeps
// the owner's own helpers away from it.

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
    await this.locked(bare, async () => {
      if (!(await exists(join(bare, 'HEAD')))) await this.init(bare, repository.cloneUrl);
      else await git.run(['-C', bare, 'remote', 'set-url', 'origin', repository.cloneUrl]);
      // An empty helper, holding no secret: the owner's global and system helpers (such as Git
      // Credential Manager on WSL) never answer for this repository or its worktrees (05,
      // section 7). Set at each preparation, so bare clones made by 0.2.0 get it too.
      await git.run(['-C', bare, 'config', 'credential.helper', '']);
      await this.fetch(start, bare, runFolder);
      if (await exists(worktree)) return;
      await mkdir(dirname(worktree), { recursive: true, mode: 0o700 });
      await git.run(['-C', bare, 'worktree', 'prune']);
      const branch = repository.ticketBranch;
      if (await git.hasRef(bare, `refs/heads/${branch}`)) {
        await git.run(['-C', bare, 'worktree', 'add', worktree, branch]);
      } else {
        const from = (await git.hasRef(bare, `refs/remotes/origin/${branch}`))
          ? `origin/${branch}`
          : `origin/${repository.baseBranch}`;
        await git.run(['-C', bare, 'worktree', 'add', '--no-track', '-b', branch, worktree, from]);
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

  private fetch(start: RunStart['payload'], bare: string, runFolder: string): Promise<void> {
    const { repository } = start;
    return withCredentialHelper(
      {
        folder: runFolder,
        cloneUrl: repository.cloneUrl,
        request: {
          runId: start.runId,
          repository: { owner: repository.owner, name: repository.name },
          command: 'fetch',
        },
        source: this.options.credentials,
        selfCommand: this.options.selfCommand,
        log: this.options.log,
      },
      async ({ gitOptions, env }) => {
        await this.options.git.run(
          [...gitOptions, '-C', bare, 'fetch', '--quiet', '--prune', 'origin'],
          env,
        );
      },
    );
  }

  /** The ticket branch's head and its commits ahead of the remote's base branch; null without it. */
  async branchReport(
    bare: string,
    repository: Pick<Repository, 'baseBranch' | 'ticketBranch'>,
  ): Promise<BranchReport | null> {
    const { git } = this.options;
    const branch = `refs/heads/${repository.ticketBranch}`;
    if (!(await git.hasRef(bare, branch))) return null;
    const head = (await git.run(['-C', bare, 'rev-parse', branch])).trim();
    const base = `refs/remotes/origin/${repository.baseBranch}`;
    const range = (await git.hasRef(bare, base)) ? `${base}..${branch}` : branch;
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
   * (no change, untracked files included), and the ticket branch's head and commits.
   */
  async facts(
    bare: string,
    worktree: string,
    repository: Pick<Repository, 'baseBranch' | 'ticketBranch'>,
  ): Promise<WorkspaceFacts | null> {
    const status = await this.options.git.run([
      '-C',
      worktree,
      'status',
      '--porcelain',
      '--untracked-files=all',
    ]);
    const branch = await this.branchReport(bare, repository);
    // Nothing is pushed and the changed files are not collected before lot 3's steps D and F.
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
