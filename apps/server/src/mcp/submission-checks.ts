import {
  shorten,
  type ChangedFiles,
  type CheckReason,
  type DodCheck,
  type DodCheckResult,
  type DodReport,
  type McpError,
  type McpErrorDetail,
  type ReportList,
  type TicketType,
  type WorkflowReason,
  type WorkspaceFacts,
} from '@orchestrator/protocol';
import type { Template } from '../agents/files.js';
import { fill, part } from '../agents/messages.js';

// The mechanical checks of a full `ticket_submit` (04, sections 3.1 and 3.3; lot 3 step F):
// criteria, the worktree, the push, the rules per ticket type and the listed paths, on the
// daemon's facts (05, section 4.9). Every text the agent reads comes from the template
// `agents/templates/submit-checks.md` (03, section 3.2).

/** Where a workflow lives: a change there is flagged (04, section 3.1). Case-sensitive. */
const WORKFLOWS = '.github/workflows/';

/** A report path after the POSIX rules of 04 section 3.1, or why it leaves the repository. */
export type NormalisedPath = { kind: 'path'; path: string } | { kind: 'outside' };

/**
 * A leading `./` removed, repeated `/` collapsed, a trailing `/` removed and `.` resolved (04,
 * section 3.1). `..` is not resolved: a path still starting with `/` or `..`, or holding a NUL
 * or a backslash, is outside the repository; one with `..` further on matches no changed file.
 * The root itself (`.`) gives an empty path, a folder.
 */
export function normalisePath(path: string): NormalisedPath {
  if (path.includes('\0') || path.includes('\\') || path.startsWith('/')) {
    return { kind: 'outside' };
  }
  const parts = path.split('/').filter((part) => part !== '' && part !== '.');
  if (parts[0] === '..') return { kind: 'outside' };
  return { kind: 'path', path: parts.join('/') };
}

/**
 * Why the workflow flag is raised, or null: a changed path under `.github/workflows/`, even in
 * the part of a cut list received; otherwise a list cut or not sent (owner's answer 2, step F4).
 */
export function workflowReason(changedFiles: ChangedFiles | null): WorkflowReason | null {
  if (changedFiles?.listed.some((path) => path.startsWith(WORKFLOWS))) return 'changed';
  if (changedFiles === null || changedFiles.listed.length < changedFiles.count) {
    return 'not_listed';
  }
  return null;
}

export interface SubmissionFacts {
  /**
   * The commits a confirmed CI round of this run sent back (lot 3 step G2b): handed in again,
   * they are refused, since CI would give the same result.
   */
  roundCommits?: readonly { commit: string; kind: 'failed' | 'conflict' }[];
  /**
   * The commit a standing request for changes was made on (owner's answer 1, lot 3 step I): handed
   * in again, it is refused, since nothing was changed for the request.
   */
  requestCommit?: { commit: string; by: 'quality' | 'owner' } | null;
  ticketType: TicketType;
  /** The ticket's acceptance criteria, in order: criterion number 1 first. */
  criteria: readonly string[];
  /** As the agent sent it, each criterion by its number from 1. */
  report: DodReport;
  workspace: WorkspaceFacts;
  baseBranch: string;
}

export interface CheckedSubmission {
  checks: DodCheckResult[];
  workflowChanges: boolean;
  workflowReason: WorkflowReason | null;
  /** The push failed: the agent is told only that, and the run ends (04, section 3.1). */
  pushFailed: boolean;
}

/** Criteria reported with a number the ticket does not have: the input is wrong. */
export function criteriaOutOfRange(
  texts: Template,
  criteria: readonly string[],
  report: DodReport,
): McpError | null {
  const outOfRange = report.criteria.filter((entry) => entry.number > criteria.length);
  if (outOfRange.length === 0) return null;
  const missing = outOfRange
    .map((entry) => part(texts, 'criteria-out-of-range-entry', { number: String(entry.number) }))
    .join(part(texts, 'criteria-out-of-range-separator'));
  return {
    code: 'VALIDATION_FAILED',
    message:
      criteria.length === 0
        ? part(texts, 'criteria-out-of-range-none', { missing })
        : part(texts, 'criteria-out-of-range', {
            count: String(criteria.length),
            missing,
          }),
    details: outOfRange.map((entry) => ({
      field: `criteria.${String(report.criteria.indexOf(entry))}.number`,
      message: part(texts, 'criteria-out-of-range-field', { number: String(entry.number) }),
    })),
  };
}

/** A check's failure: the agent's message and the same as facts, for the owner's screens. */
interface Issue {
  message: string;
  reason: CheckReason;
}

const result = (check: DodCheck, issues: Issue[]): DodCheckResult => ({
  check,
  result: issues.length > 0 ? 'failed' : 'passed',
  messages: issues.map((issue) => issue.message),
  reasons: issues.map((issue) => issue.reason),
});

/** Every check, in the order of 04 section 3.1; the refusal is built from them. */
export function checkSubmission(texts: Template, facts: SubmissionFacts): CheckedSubmission {
  const { report, workspace } = facts;
  const branch = workspace.branch.name;

  const criteria: Issue[] = [];
  facts.criteria.forEach((text, index) => {
    const entry = report.criteria.find((each) => each.number === index + 1);
    const short = shorten(text, 120);
    const values = { number: String(index + 1), text: short };
    if (!entry) {
      criteria.push({
        message: part(texts, 'criterion-missing', values),
        reason: { kind: 'criterion_missing', index, text: short },
      });
    } else if (entry.status !== 'met') {
      criteria.push({
        message: part(texts, 'criterion-not-met', values),
        reason: { kind: 'criterion_not_met', index, text: short },
      });
    }
  });

  const clean: Issue[] = workspace.clean
    ? []
    : [{ message: part(texts, 'worktree-dirty'), reason: { kind: 'uncommitted_changes' } }];
  const ahead: Issue[] =
    workspace.branch.commitsAhead.length > 0
      ? []
      : [
          {
            message: part(texts, 'no-commits', { branch, base: facts.baseBranch }),
            reason: { kind: 'no_commits', base: facts.baseBranch },
          },
        ];
  // The commit handed in: the one pushed, else the branch head the machine read.
  const handedIn =
    workspace.push?.status === 'pushed' ? workspace.push.head : workspace.branch.head;
  const again = facts.roundCommits?.find((round) => round.commit === handedIn);
  if (again !== undefined) {
    const base = facts.baseBranch;
    ahead.push({
      message: part(texts, `same-commit-${again.kind}`, { commit: again.commit, branch, base }),
      reason: { kind: 'same_commit', commit: again.commit, ci: again.kind, base },
    });
  } else if (facts.requestCommit?.commit === handedIn) {
    const { commit, by } = facts.requestCommit;
    ahead.push({
      message: part(texts, `same-commit-${by}`, { commit, branch }),
      reason: { kind: 'same_commit_request', commit, by },
    });
  }

  // The daemon pushes only a clean worktree with commits ahead (05, section 4.9).
  const push = workspace.push;
  let pushed: DodCheckResult;
  if (push?.status === 'pushed') pushed = result('pushed', []);
  else if (push?.status === 'failed') {
    pushed = result('pushed', [
      {
        message: part(texts, `push-${push.reason}`, { branch }),
        reason: { kind: `push_${push.reason}` },
      },
    ]);
  } else if (clean.length > 0 || ahead.length > 0) {
    pushed = { check: 'pushed', result: 'skipped', messages: [], reasons: [] };
  } else {
    pushed = result('pushed', [
      { message: part(texts, 'push-missing', { branch }), reason: { kind: 'push_missing' } },
    ]);
  }

  const paths = checkPaths(texts, facts);
  return {
    checks: [
      result('criteria_met', criteria),
      result('worktree_clean', clean),
      result('commits_ahead', ahead),
      pushed,
      paths.typeRules,
      paths.pathsChanged,
    ],
    workflowChanges: workflowReason(workspace.changedFiles) !== null,
    workflowReason: workflowReason(workspace.changedFiles),
    pushFailed: push?.status === 'failed',
  };
}

/** How a listed path compares with the branch's changed files. */
type PathState = 'changed' | 'unknown' | 'failed';

function checkPaths(
  texts: Template,
  facts: SubmissionFacts,
): { typeRules: DodCheckResult; pathsChanged: DodCheckResult } {
  const { report } = facts;
  const changed = facts.workspace.changedFiles;
  const listedPaths = changed?.listed ?? [];
  const listed = new Set(listedPaths);
  const complete = changed !== null && changed.listed.length === changed.count;
  const failures: Issue[] = [];
  let unchecked = 0;

  const fields: Record<ReportList, string> = {
    tests: 'tests.paths',
    docs: 'docs.paths',
    adrs: 'adrs',
  };
  const state = (list: ReportList, path: string): PathState => {
    const field = fields[list];
    const normalised = normalisePath(path);
    if (normalised.kind === 'outside') {
      failures.push({
        message: part(texts, 'path-outside', { field, path }),
        reason: { kind: 'path_outside', list, path },
      });
      return 'failed';
    }
    if (listed.has(normalised.path)) return 'changed';
    const prefix = normalised.path === '' ? '' : `${normalised.path}/`;
    if (normalised.path === '' || listedPaths.some((each) => each.startsWith(prefix))) {
      failures.push({
        message: part(texts, 'path-folder', { field, path }),
        reason: { kind: 'path_folder', list, path },
      });
      return 'failed';
    }
    if (complete) {
      failures.push({
        message: part(texts, 'path-not-changed', { field, path, base: facts.baseBranch }),
        reason: { kind: 'path_not_changed', list, path },
      });
      return 'failed';
    }
    unchecked += 1;
    return 'unknown';
  };
  for (const path of report.tests.paths) state('tests', path);
  const docs = report.docs.paths.map((path) => state('docs', path));
  const adrs = report.adrs.map((path) => state('adrs', path));

  const incomplete: Issue =
    changed === null
      ? { message: part(texts, 'paths-unknown'), reason: { kind: 'files_not_sent' } }
      : {
          message: part(texts, 'paths-cut', {
            listed: String(changed.listed.length),
            count: String(changed.count),
            unchecked: String(unchecked),
          }),
          reason: {
            kind: 'files_cut',
            listed: changed.listed.length,
            count: changed.count,
            unchecked,
          },
        };
  const pathsChanged: DodCheckResult =
    failures.length > 0 || unchecked === 0
      ? result('paths_changed', failures)
      : {
          check: 'paths_changed',
          result: 'incomplete',
          messages: [incomplete.message],
          reasons: [incomplete.reason],
        };

  // 04 section 3.3: a docs ticket needs a documentation path, a spike an ADR or one; changed on
  // the branch, or not known otherwise when the machine's list was cut.
  const required =
    facts.ticketType === 'docs'
      ? { states: docs, text: 'type-docs', kind: 'docs_rule' as const }
      : facts.ticketType === 'spike'
        ? { states: [...adrs, ...docs], text: 'type-spike', kind: 'spike_rule' as const }
        : null;
  let typeRules: DodCheckResult = result('type_rules', []);
  if (required !== null && !required.states.includes('changed')) {
    typeRules = required.states.includes('unknown')
      ? {
          check: 'type_rules',
          result: 'incomplete',
          messages: [incomplete.message],
          reasons: [incomplete.reason],
        }
      : result('type_rules', [
          { message: part(texts, required.text), reason: { kind: required.kind } },
        ]);
  }
  return { typeRules, pathsChanged };
}

/**
 * The answer to a refused submission (04, section 3.1; 06, section 4.2): after a failed push only
 * the push, which the agent cannot fix, so it ends its turn; otherwise every failed check. Null
 * when every check passed or could not be fully done.
 */
export function refusal(texts: Template, checked: CheckedSubmission): McpError | null {
  const details: McpErrorDetail[] = checked.checks.flatMap((each) =>
    each.result === 'failed' && (!checked.pushFailed || each.check === 'pushed')
      ? each.messages.map((message) => ({ check: each.check, message }))
      : [],
  );
  if (details.length === 0) return null;
  const message = checked.pushFailed
    ? part(texts, 'refused-push')
    : details.length === 1
      ? part(texts, 'refused-one')
      : fill(texts, texts.main, { count: String(details.length) });
  return { code: 'DOD_FAILED', message, details };
}
