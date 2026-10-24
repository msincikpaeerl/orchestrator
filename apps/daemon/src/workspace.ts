import { mkdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  BRANCH_REPORT_COMMITS_MAX_BYTES,
  BRANCH_REPORT_MAX_COMMITS,
  CHANGED_FILES_MAX_BYTES,
  COMMIT_SUBJECT_MAX_CHARACTERS,
  PUSH_MESSAGE_MAX_CHARACTERS,
  cutText,
  fitList,
  type BranchDeleteAnswer,
  type BranchReport,
  type ChangedFiles,
  type NotOnGitHub,
  type PushResult,
  type RunStart,
  type WorkspaceFacts,
} from '@orchestrator/protocol';
import type { Logger } from 'pino';
import type { CredentialSource } from './credentials.js';
import { GitError, type Git } from './git.js';
import { ORIGIN_FETCH, restoreBareConfig } from './bare-config.js';
import { isolatedFetch, isolatedPush, type IsolatedGitOptions } from './isolated-git.js';
import type { DaemonPaths } from './paths.js';
import { RUN_MARKER } from './processes.js';
import type { TrustRegistry } from './trust.js';

// A run's Git workspace (05, section 4.2): one bare clone per repository, reused across runs,
// and one worktree per run on the ticket branch. A planning run (protocol 3, lot 5) has no ticket
// branch: its worktree is detached at GitHub's base branch, or, for a new project, an empty
// scratch folder with no Git. The bare clone receives the remote's branches
// in `refs/remotes/origin/*`, so a fetch never overwrites a ticket branch holding commits not
// pushed yet. Fetches and pushes hold the credential and run in an isolated repository
// (`isolated-git.ts`), never reading the bare clone's configuration, which an agent can change;
// the bare clone's empty `credential.helper` keeps the owner's own helpers away from the agent's
// own Git commands.

type Repository = NonNullable<RunStart['payload']['repository']>;

/** The repository of a run that works on a ticket branch: every run but a planning run. */
export type TicketRepository = Repository & { ticketBranch: string };

/** The run's repository with its ticket branch; null for a planning run, which has none. */
export function ticketRepository(start: RunStart['payload']): TicketRepository | null {
  const { repository } = start;
  if (repository?.ticketBranch === undefined) return null;
  return { ...repository, ticketBranch: repository.ticketBranch };
}

export interface WorkspaceOptions {
  paths: DaemonPaths;
  git: Git;
  trust: TrustRegistry;
  credentials: CredentialSource;
  selfCommand: readonly string[];
  log: Logger;
}

export function bareClonePath(
  paths: DaemonPaths,
  repository: Pick<Repository, 'owner' | 'name'>,
): string {
  return join(paths.home, 'repos', repository.owner, `${repository.name}.git`);
}

export function worktreePath(paths: DaemonPaths, runId: string): string {
  return join(paths.home, 'worktrees', runId);
}

/**
 * Where a review run started (05, section 4.2): its worktree's head, GitHub's head of the ticket
 * branch as fetched at preparation, and the local ticket branch's head (null without one).
 */
export interface ReviewStart {
  head: string;
  localBranch: string | null;
}

/**
 * GitHub's head of the ticket branch is not the commit a review run was started for: the run
 * ends with `review_branch_moved` before any session (04, section 3.2; lot 3 step H).
 */
export class ReviewCommitMoved extends Error {
  constructor(
    readonly head: string,
    expected: string,
  ) {
    super(
      `The ticket branch on GitHub moved since the review was started: it is now ${head.slice(0, 7)}, not ${expected.slice(0, 7)}.`,
    );
    this.name = 'ReviewCommitMoved';
  }
}

/**
 * A prepared workspace; `review` for a review run. `bare` is null for a planning run of a new
 * project, whose worktree is a scratch folder.
 */
export interface PreparedWorkspace {
  bare: string | null;
  worktree: string;
  review: ReviewStart | null;
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
  async prepare(start: RunStart['payload'], runFolder: string): Promise<PreparedWorkspace> {
    const { git, paths } = this.options;
    const { repository } = start;
    const worktree = worktreePath(paths, start.runId);
    if (repository === undefined) return this.prepareScratch(worktree);
    const bare = bareClonePath(paths, repository);
    const marker = { [RUN_MARKER]: start.runId };
    let review: ReviewStart | null = null;
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
      await isolatedFetch(this.isolated(start, repository, runFolder), bare);
      if (await exists(worktree)) return;
      await mkdir(dirname(worktree), { recursive: true, mode: 0o700 });
      await git.run(['-C', bare, 'worktree', 'prune'], marker);
      const ticket = ticketRepository(start);
      if (ticket === null) {
        await this.addPlanningWorktree(bare, worktree, repository.baseBranch, marker);
      } else if (start.purpose === 'review') {
        review = await this.addReviewWorktree(
          bare,
          worktree,
          ticket.ticketBranch,
          start.reviewCommit,
          marker,
        );
      } else {
        await this.addWorktree(bare, worktree, ticket, marker);
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
    return { bare, worktree, review };
  }

  /**
   * The workspace of a planning run of a new project (05, section 4.2): an empty scratch folder,
   * no Git, trusted for its own path, since there is no bare clone to hold the trust. Kept as it
   * is for a resumed run.
   */
  private async prepareScratch(worktree: string): Promise<PreparedWorkspace> {
    await mkdir(dirname(worktree), { recursive: true, mode: 0o700 });
    await mkdir(worktree, { recursive: true, mode: 0o700 });
    await this.options.trust.ensure(worktree);
    return { bare: null, worktree, review: null };
  }

  /** A ref's commit in the bare clone; null when the ref does not exist. */
  private async head(bare: string, ref: string): Promise<string | null> {
    const read = await this.options.git.exec([
      '-C',
      bare,
      'rev-parse',
      '--verify',
      '--quiet',
      `${ref}^{commit}`,
    ]);
    return read.code === 0 ? read.stdout.trim() : null;
  }

  /** The worktree, other than the bare clone itself, that has `branch` checked out; null if none. */
  private async checkedOutBy(bare: string, branch: string): Promise<string | null> {
    const listed = await this.options.git.run(['-C', bare, 'worktree', 'list', '--porcelain']);
    let path: string | null = null;
    for (const line of listed.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
      else if (line === `branch refs/heads/${branch}`) return path;
    }
    return null;
  }

  /**
   * The worktree of an `implement` or `fix_review` run (05, section 4.2): on the local ticket
   * branch, fast-forwarded first to GitHub's when GitHub's contains it (after **Update branch**);
   * else on GitHub's ticket branch; else a new branch from GitHub's base branch. A diverged branch
   * is left as it is (its push reports `diverged`), and a branch another worktree has checked out
   * (a waiting or paused run) is never moved.
   */
  private async addWorktree(
    bare: string,
    worktree: string,
    repository: TicketRepository,
    marker: Record<string, string>,
  ): Promise<void> {
    const { git } = this.options;
    const branch = repository.ticketBranch;
    const local = await this.head(bare, `refs/heads/${branch}`);
    if (local !== null) {
      const holder = await this.checkedOutBy(bare, branch);
      if (holder !== null) {
        throw new Error(
          `The ticket branch ${branch} is checked out by another run on this machine (${basename(holder)}), waiting for an answer or paused: it is left as it is. Stop that run first.`,
        );
      }
      const github = await this.head(bare, `refs/remotes/origin/${branch}`);
      if (github !== null && github !== local) {
        const contained =
          (await git.exec(['-C', bare, 'merge-base', '--is-ancestor', local, github])).code === 0;
        if (contained) {
          // The old value makes Git refuse the update if the branch moved meanwhile.
          await git.run(['-C', bare, 'update-ref', `refs/heads/${branch}`, github, local], marker);
          this.options.log.info(
            { branch, from: local, to: github },
            "ticket branch fast-forwarded to GitHub's",
          );
        }
      }
      await git.run(['-C', bare, 'worktree', 'add', worktree, branch], marker);
      return;
    }
    const from = (await git.hasRef(bare, `refs/remotes/origin/${branch}`))
      ? `origin/${branch}`
      : `origin/${repository.baseBranch}`;
    await git.run(
      ['-C', bare, 'worktree', 'add', '--no-track', '-b', branch, worktree, from],
      marker,
    );
  }

  /**
   * The worktree of a review run (05, section 4.2): detached at GitHub's head of the ticket
   * branch as fetched just now, so the review sees what the pull request holds, never commits
   * only this machine has. The local ticket branch is neither created nor moved.
   */
  private async addReviewWorktree(
    bare: string,
    worktree: string,
    branch: string,
    expected: string | undefined,
    marker: Record<string, string>,
  ): Promise<ReviewStart> {
    const head = await this.head(bare, `refs/remotes/origin/${branch}`);
    if (head === null) {
      throw new Error(`The ticket branch ${branch} is not on GitHub: there is nothing to review.`);
    }
    // The commit the server fixed at Start review (04, section 3.2; owner's answer 2b, step H).
    if (expected !== undefined && head !== expected) throw new ReviewCommitMoved(head, expected);
    const localBranch = await this.head(bare, `refs/heads/${branch}`);
    await this.options.git.run(['-C', bare, 'worktree', 'add', '--detach', worktree, head], marker);
    return { head, localBranch };
  }

  /**
   * The worktree of a planning run of an existing project (05, section 4.2): detached at GitHub's
   * head of the base branch as fetched just now; no local branch is created.
   */
  private async addPlanningWorktree(
    bare: string,
    worktree: string,
    baseBranch: string,
    marker: Record<string, string>,
  ): Promise<void> {
    const head = await this.head(bare, `refs/remotes/origin/${baseBranch}`);
    if (head === null) {
      throw new Error(
        `The base branch ${baseBranch} is not on GitHub: there is nothing to plan from.`,
      );
    }
    await this.options.git.run(['-C', bare, 'worktree', 'add', '--detach', worktree, head], marker);
  }

  /**
   * Whether a review run moved the branch (05, section 4.2): its worktree's head or the local
   * ticket branch differs from what it was at the start. A head that cannot be read counts as
   * moved. Also gives the worktree's head, null when unreadable.
   */
  async reviewHeads(
    bare: string,
    worktree: string,
    branch: string,
    started: ReviewStart,
  ): Promise<{ moved: boolean; head: string | null }> {
    const read = await this.options.git.exec([
      '--git-dir',
      join(bare, 'worktrees', basename(worktree)),
      'rev-parse',
      '--verify',
      '--quiet',
      'HEAD^{commit}',
    ]);
    const head = read.code === 0 ? read.stdout.trim() : null;
    const localBranch = await this.head(bare, `refs/heads/${branch}`);
    return { moved: head !== started.head || localBranch !== started.localBranch, head };
  }

  /**
   * At a run's end (05, section 7.1), once its worktree is removed: the bare clone's configuration
   * and hooks restored to what the daemon wrote, under the bare clone's lock; what changed in
   * plain words, null if nothing. Skipped while another run's worktree of the repository exists
   * (working, waiting or paused): what it set up (husky's hooks, for example) keeps working, and
   * the last run to end restores. Credentialed commands never read that configuration, so
   * waiting costs nothing for the token.
   */
  restoreConfig(bare: string, cloneUrl: string): Promise<string | null> {
    return this.locked(bare, async () => {
      const others = await this.otherWorktrees(bare);
      if (others.length > 0) {
        this.options.log.info(
          { worktrees: others },
          "Git configuration not restored: another run's worktree of the repository exists",
        );
        return null;
      }
      return restoreBareConfig(this.options.git, bare, cloneUrl);
    });
  }

  /** The worktrees of the bare clone, after forgetting those whose folder is gone. */
  private async otherWorktrees(bare: string): Promise<string[]> {
    const { git } = this.options;
    await git.exec(['-C', bare, 'worktree', 'prune']);
    const listed = await git.run(['-C', bare, 'worktree', 'list', '--porcelain']);
    const worktrees: string[] = [];
    let path: string | null = null;
    for (const line of listed.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
      // The bare clone itself is listed first, marked `bare`.
      else if (line === '' && path !== null) {
        worktrees.push(path);
        path = null;
      } else if (line === 'bare') path = null;
    }
    if (path !== null) worktrees.push(path);
    return worktrees;
  }

  /**
   * The best-effort push at a run's end (05, section 4.9): the ticket branch's head, read once,
   * pushed when it holds commits on no branch fetched from GitHub; null when there is nothing to
   * push. Never throws.
   */
  async endPush(
    start: RunStart['payload'],
    bare: string,
    runFolder: string,
  ): Promise<PushResult | null> {
    const repository = ticketRepository(start);
    if (repository === null) return null;
    const head = await this.head(bare, `refs/heads/${repository.ticketBranch}`).catch(() => null);
    if (head === null) return null;
    const unpushed = await this.unpushed(bare, head).catch(() => []);
    if (unpushed.length === 0) return null;
    return this.push(start, bare, runFolder, head);
  }

  /**
   * The commits of `head` on no branch fetched from GitHub (`refs/remotes/origin/*`, as fetched at
   * preparation or moved by a push), newest first: what the end push pushes, and what a branch
   * report says is not on GitHub (05, section 4.9). One rule, in one place.
   */
  private async unpushed(bare: string, head: string): Promise<string[]> {
    const listed = await this.options.git.run([
      '-C',
      bare,
      'rev-list',
      head,
      '--not',
      '--remotes=origin',
    ]);
    return listed.split('\n').filter(Boolean);
  }

  /**
   * What of a branch report is not on GitHub now (lot 3 step D3): the listed commits on no branch
   * fetched from GitHub, and how many there are in all. Null when it cannot be read: the server
   * then counts every commit no push held.
   */
  async notOnGitHub(bare: string, report: BranchReport): Promise<NotOnGitHub | null> {
    try {
      const unpushed = new Set(await this.unpushed(bare, report.head));
      return {
        listed: report.commitsAhead
          .map((commit) => commit.hash)
          .filter((hash) => unpushed.has(hash)),
        count: unpushed.size,
      };
    } catch (error) {
      this.options.log.warn({ err: error }, 'commits not on GitHub not read');
      return null;
    }
  }

  private async init(bare: string, cloneUrl: string): Promise<void> {
    const { git } = this.options;
    await mkdir(dirname(bare), { recursive: true, mode: 0o700 });
    try {
      await git.run(['init', '--quiet', '--bare', bare]);
      await git.run(['-C', bare, 'remote', 'add', 'origin', cloneUrl]);
      await git.run(['-C', bare, 'config', 'remote.origin.fetch', ORIGIN_FETCH]);
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
  /**
   * Downloads the run's base branch from GitHub into the bare clone's `refs/remotes/origin/<base>`
   * (lot 3 step G2a), under the bare clone's lock, through the isolated fetch (05, section 7.1):
   * before the agent is told to merge it after a conflict. Throws with the masked reason.
   */
  async fetchBase(start: RunStart['payload'], runFolder: string, bare: string): Promise<void> {
    const { repository } = start;
    if (repository === undefined)
      throw new Error('A planning run of a new project has no repository.');
    const base = repository.baseBranch;
    try {
      await this.locked(bare, () =>
        isolatedFetch(this.isolated(start, repository, runFolder), bare, base),
      );
    } catch (error) {
      throw new Error(`Downloading ${base} from GitHub failed: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }

  private isolated(
    start: RunStart['payload'],
    repository: Repository,
    runFolder: string,
  ): IsolatedGitOptions {
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
      const repository = ticketRepository(start);
      // A planning run never pushes (05, section 4.2): no caller asks, so this is a bug.
      if (repository === null) throw new Error('a planning run has no ticket branch');
      const branch = repository.ticketBranch;
      return await this.locked(bare, async () => {
        const result = await isolatedPush(
          this.isolated(start, repository, runFolder),
          bare,
          branch,
          head,
        );
        if (result.status === 'pushed') {
          // As Git does after a push: the bare clone knows the head is on GitHub now, so the end
          // push and `status` do not count it as not on GitHub (no credential: a local command).
          await this.options.git
            .run(['-C', bare, 'update-ref', `refs/remotes/origin/${branch}`, head], {
              [RUN_MARKER]: start.runId,
            })
            .catch((error: unknown) => {
              this.options.log.warn({ err: error }, 'remote branch not updated after the push');
            });
        }
        return result;
      });
    } catch (error) {
      this.options.log.error({ err: error }, 'push not attempted');
      return {
        status: 'failed',
        reason: 'unreachable',
        message: cutText(
          `The push could not start: ${error instanceof Error ? error.message : String(error)}`,
          PUSH_MESSAGE_MAX_CHARACTERS,
          'end',
        ),
      };
    }
  }

  /**
   * The ticket branch's head and its commits ahead of the remote's base branch; null without it.
   * `at` reports another head under the branch's name: a review run's worktree head.
   */
  async branchReport(
    bare: string,
    repository: Pick<TicketRepository, 'baseBranch' | 'ticketBranch'>,
    at?: string,
  ): Promise<BranchReport | null> {
    const { git } = this.options;
    // Read once: the commits listed, the head reported and the hash pushed are this one.
    const head = at ?? (await this.head(bare, `refs/heads/${repository.ticketBranch}`));
    if (head === null) return null;
    const base = `refs/remotes/origin/${repository.baseBranch}`;
    const range = (await git.hasRef(bare, base)) ? `${base}..${head}` : head;
    // The newest commits only: those beyond the ceiling are counted in `notOnGitHub`.
    const log = await git.run([
      '-C',
      bare,
      'log',
      // `log.showSignature`, set by an agent, would start `gpg.program` (lot 3 step F).
      '--no-show-signature',
      `--max-count=${String(BRANCH_REPORT_MAX_COMMITS)}`,
      '--format=%H%x00%s',
      range,
    ]);
    const report: BranchReport = {
      name: repository.ticketBranch,
      head,
      // Within the budgets (04, section 8; lot 3 step F): subjects cut with a marker, and the
      // newest commits that fit; `notOnGitHub` still counts every commit.
      commitsAhead: fitList(
        log
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [hash = '', subject = ''] = line.split('\0');
            return { hash, subject: cutText(subject, COMMIT_SUBJECT_MAX_CHARACTERS) };
          }),
        BRANCH_REPORT_COMMITS_MAX_BYTES,
      ),
      notOnGitHub: null,
    };
    report.notOnGitHub = await this.notOnGitHub(bare, report);
    return report;
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
    repository: Pick<TicketRepository, 'baseBranch' | 'ticketBranch'>,
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
    if (!branch) return null;
    // The push is added by the run.
    return {
      clean: status.trim() === '',
      branch,
      push: null,
      changedFiles: await this.changedFiles(bare, repository, branch.head),
    };
  }

  /**
   * The files `head` changed against the base branch, as GitHub's "Files changed" tab compares
   * them (05, section 4.9; lot 3 step F): from the merge base with the fetched base branch, so
   * what the base brought, merged or not, is not listed; a rename gives both paths, a deletion
   * its path. Without a base branch or a merge base, every file of `head`. Sorted, the first that
   * fit `CHANGED_FILES_MAX_BYTES` listed, all counted. Plumbing commands only, reading no file
   * content and no worktree: no external diff, text conversion, pager, attribute driver or filter
   * an agent named can start.
   */
  async changedFiles(
    bare: string,
    repository: Pick<Repository, 'baseBranch'>,
    head: string,
  ): Promise<ChangedFiles> {
    const { git } = this.options;
    const base = `refs/remotes/origin/${repository.baseBranch}`;
    let mergeBase: string | null = null;
    if (await git.hasRef(bare, base)) {
      const found = await git.exec(['-C', bare, 'merge-base', base, head]);
      // 1: no common ancestor.
      if (found.code === 0) mergeBase = found.stdout.trim();
      else if (found.code !== 1) throw new Error(`merge base not read: ${found.stderr.trim()}`);
    }
    const listing = await git.run(
      mergeBase === null
        ? ['-C', bare, 'ls-tree', '-r', '-z', '--name-only', head]
        : [
            '-C',
            bare,
            'diff-tree',
            '-r',
            '-z',
            '--name-only',
            '--no-renames',
            '--no-commit-id',
            '--no-ext-diff',
            '--no-textconv',
            '--ignore-submodules=none',
            mergeBase,
            head,
          ],
    );
    const paths = [...new Set(listing.split('\0').filter(Boolean))].sort();
    return { listed: fitList(paths, CHANGED_FILES_MAX_BYTES), count: paths.length };
  }

  /**
   * Deletes the local ticket branch after its pull request's merge (05, section 4.11; lot 3 step
   * J2b), under the bare clone's lock, so no run's preparation, end or push works in it meanwhile.
   * Kept when the bare clone's `HEAD` names it, a worktree has it, or `runActive` says a run of the
   * repository is active; deleted only by `update-ref` with the merged head as the old value, so a
   * branch that moved even after it was read is kept. The name is the caller's to check.
   */
  async deleteMergedBranch(
    repository: Pick<Repository, 'owner' | 'name'>,
    branch: string,
    mergedHead: string,
    runActive: () => boolean,
  ): Promise<BranchDeleteAnswer> {
    const { git, paths } = this.options;
    const bare = bareClonePath(paths, repository);
    if (!(await exists(join(bare, 'HEAD')))) return { outcome: 'not_found', what: 'repository' };
    return this.locked(bare, async () => {
      const ref = `refs/heads/${branch}`;
      const head = await this.head(bare, ref);
      if (head === null) return { outcome: 'not_found', what: 'branch' };
      const bareHead = await git.exec(['-C', bare, 'symbolic-ref', '--quiet', 'HEAD']);
      if (bareHead.stdout.trim() === ref) return { outcome: 'in_use', by: 'bare_head' };
      if ((await this.checkedOutBy(bare, branch)) !== null) {
        return { outcome: 'in_use', by: 'worktree' };
      }
      if (runActive()) return { outcome: 'in_use', by: 'run' };
      // Only the merged head is deleted: Git compares and deletes in one step.
      const deleted = await git.exec(['-C', bare, 'update-ref', '-d', ref, mergedHead]);
      if (deleted.code === 0) return { outcome: 'deleted' };
      const now = await this.head(bare, ref);
      if (now === null) return { outcome: 'not_found', what: 'branch' };
      if (now !== mergedHead) return { outcome: 'kept', head: now };
      throw new GitError(['update-ref', '-d', ref, mergedHead], deleted.code, deleted.stderr);
    });
  }

  /**
   * Removes the run's worktree; its branch stays in the bare clone (05, section 4.11). Without a
   * bare clone (a scratch folder, or a run that stopped before it knew its bare clone), the folder
   * is deleted; Git forgets a worktree whose folder is gone at the next preparation.
   */
  async remove(bare: string | null, worktree: string): Promise<void> {
    const { git } = this.options;
    if (bare === null) {
      await rm(worktree, { recursive: true, force: true });
      return;
    }
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
