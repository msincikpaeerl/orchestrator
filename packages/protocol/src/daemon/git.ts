import { z } from 'zod';
import { boundedText, requiredText } from '../text-limits.js';

/** A full commit hash: SHA-1 (40 hexadecimal digits) or SHA-256 (64). */
export const GitHash = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'must be a full commit hash');
export type GitHash = z.infer<typeof GitHash>;

/**
 * A branch name the daemon can pass to Git as an argument: no leading `-` (it would read as an
 * option), no `..`, no empty part, no trailing `/`, `.` or `.lock`.
 */
export const GitBranchName = requiredText().refine(
  (name) =>
    /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(name) &&
    !name.includes('..') &&
    !name.includes('//') &&
    !/(?:\/|\.|\.lock)$/.test(name),
  'must be a valid branch name',
);
export type GitBranchName = z.infer<typeof GitBranchName>;

/** A commit ahead of the base branch, as the ticket page lists it (01, section 3.7). */
export const CommitSummary = z.object({ hash: GitHash, subject: boundedText() });
export type CommitSummary = z.infer<typeof CommitSummary>;

/**
 * Most commits a branch report lists (05, section 4.9; lot 3 step D3): the newest ones. Commits
 * beyond it are only counted, and a commit the server is not told about counts as not on GitHub.
 */
export const BRANCH_REPORT_MAX_COMMITS = 500;

/**
 * The commits of the branch that are on no branch the machine fetched from GitHub (as fetched at
 * the run's preparation, or moved by a push it made): the rule of the end push, computed by the
 * same code (05, section 4.9; lot 3 step D3). `listed`: those among `commitsAhead`, newest first;
 * `count`: all of them, listed or not.
 */
export const NotOnGitHub = z
  .object({
    listed: z.array(GitHash).max(BRANCH_REPORT_MAX_COMMITS),
    count: z.int().min(0),
  })
  .refine((value) => value.listed.length <= value.count, 'count is below the listed commits');
export type NotOnGitHub = z.infer<typeof NotOnGitHub>;

/** The ticket branch in the machine's bare clone: its head and the commits ahead of the base. */
export const BranchReport = z.object({
  name: GitBranchName,
  head: GitHash,
  /** Newest first, at most `BRANCH_REPORT_MAX_COMMITS`. */
  commitsAhead: z.array(CommitSummary).max(BRANCH_REPORT_MAX_COMMITS),
  /**
   * What of it is not on GitHub, as the machine knows (protocol 2); null when not read, and
   * absent from protocol 1: the server then counts every commit no push held.
   */
  notOnGitHub: NotOnGitHub.nullable().default(null),
});
export type BranchReport = z.infer<typeof BranchReport>;

/** GitHub account or organisation name: a path part of the bare clone (05, section 4.2). */
export const RepositoryOwner = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'must be a GitHub account name');

/** Why a push of the ticket branch failed (05, section 4.9). */
export const PushFailureReason = z.enum([
  /** GitHub's branch has commits the local one does not: never forced (05, section 4.9). */
  'diverged',
  /** GitHub, or the server giving the credential, refused it. */
  'refused',
  /** GitHub or the server could not be reached. */
  'unreachable',
]);
export type PushFailureReason = z.infer<typeof PushFailureReason>;

/**
 * A push of the ticket branch by the daemon (05, section 4.9; protocol 2): only that branch, by an
 * explicit refspec, never forced. `pushed` gives the head now on GitHub; `failed` says why, in
 * the words of Git or of the server that refused the credential.
 */
export const PushResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pushed'), head: GitHash }),
  z.object({ status: z.literal('failed'), reason: PushFailureReason, message: requiredText() }),
]);
export type PushResult = z.infer<typeof PushResult>;
