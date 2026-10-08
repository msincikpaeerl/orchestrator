import { z } from 'zod';
import { requiredText, settingCeiling } from '../text-limits.js';
import { DodCheck } from './errors.js';

const CRITERIA_CEILING = settingCeiling('ticketMaxAcceptanceCriteria');

/** Tests or documentation of a submission: the files, or why none were needed (04, section 3.1). */
const SubmittedFiles = z
  .strictObject({
    paths: z.array(requiredText()),
    justification: requiredText().nullable(),
  })
  .refine((files) => files.paths.length > 0 || files.justification !== null, {
    message: 'list the files, or give a justification when none were needed',
    path: ['justification'],
  });

/** `ticket_submit` input: the Definition of Done report (04, section 3.1; 06, section 4.2). */
export const DodReport = z.strictObject({
  criteria: z
    .array(
      z.strictObject({
        /** Position of the acceptance criterion, from 0. */
        index: z
          .int()
          .min(0)
          .max(CRITERIA_CEILING - 1),
        status: z.enum(['met', 'not_met']),
        justification: requiredText(),
      }),
    )
    .max(CRITERIA_CEILING)
    .refine((criteria) => new Set(criteria.map((c) => c.index)).size === criteria.length, {
      message: 'each criterion is reported once',
    }),
  tests: SubmittedFiles,
  docs: SubmittedFiles,
  /** ADR files added, when a technical decision was made. */
  adrs: z.array(requiredText()),
  /** Short summary of the change, for the pull request description. */
  summary: requiredText(),
});
export type DodReport = z.infer<typeof DodReport>;

/** The report's list a path came from: tests, documentation or ADRs. */
export const ReportList = z.enum(['tests', 'docs', 'adrs']);
export type ReportList = z.infer<typeof ReportList>;

/**
 * Why a check failed or could not be fully done, as facts (lot 3 step F4): the screens word it
 * for the owner when they show it, so a wording fix applies to every submission kept. One per
 * message, in the same order. Strings are the agent's or the ticket's (a path, a criterion).
 */
export const CheckReason = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('criterion_missing'), index: z.int().min(0), text: z.string() }),
  z.object({ kind: z.literal('criterion_not_met'), index: z.int().min(0), text: z.string() }),
  z.object({ kind: z.literal('uncommitted_changes') }),
  z.object({ kind: z.literal('no_commits'), base: z.string() }),
  z.object({ kind: z.literal('push_diverged') }),
  z.object({ kind: z.literal('push_refused') }),
  z.object({ kind: z.literal('push_unreachable') }),
  z.object({ kind: z.literal('push_missing') }),
  z.object({ kind: z.literal('docs_rule') }),
  z.object({ kind: z.literal('spike_rule') }),
  z.object({ kind: z.literal('path_outside'), list: ReportList, path: z.string() }),
  z.object({ kind: z.literal('path_folder'), list: ReportList, path: z.string() }),
  z.object({ kind: z.literal('path_not_changed'), list: ReportList, path: z.string() }),
  z.object({
    kind: z.literal('files_cut'),
    listed: z.int().min(0),
    count: z.int().min(0),
    unchecked: z.int().min(0),
  }),
  z.object({ kind: z.literal('files_not_sent') }),
]);
export type CheckReason = z.infer<typeof CheckReason>;
export type CheckReasonKind = CheckReason['kind'];

/**
 * One submission check's result (04, section 3.1; lot 3 step F): `incomplete` when the server
 * could not fully do it (the machine's list of changed files was cut, or not sent), which never
 * refuses a submission; `skipped` when an earlier check made it pointless (no push is tried on a
 * worktree with uncommitted changes). `messages` are the texts the agent received, or for an
 * incomplete check what could not be done; `reasons` the same as facts, empty for a submission
 * kept before step F4.
 */
export const DodCheckResult = z.object({
  check: DodCheck,
  result: z.enum(['passed', 'failed', 'incomplete', 'skipped']),
  messages: z.array(z.string()),
  reasons: z.array(CheckReason).default([]),
});
export type DodCheckResult = z.infer<typeof DodCheckResult>;

/**
 * Why the workflow flag is raised (04, section 3.1; lot 3 step F4): a changed file under
 * `.github/workflows/` (also when it is in the part of a cut list received), or the machine's
 * list of changed files cut or not sent, so a workflow change cannot be ruled out.
 */
export const WorkflowReason = z.enum(['changed', 'not_listed']);
export type WorkflowReason = z.infer<typeof WorkflowReason>;

/**
 * A submission as the server checked it: kept for the accepted one (on the run and the ticket)
 * and for each run's latest refused one (lot 3 step F, owner's addition).
 */
export const SubmissionRecord = z.object({
  at: z.iso.datetime(),
  report: DodReport,
  checks: z.array(DodCheckResult),
  /** The branch changes `.github/workflows/`, or its changed files were cut or not sent. */
  workflowChanges: z.boolean(),
  /** Why the flag is raised; null when it is not, or for a submission kept before step F4. */
  workflowReason: WorkflowReason.nullable().default(null),
});
export type SubmissionRecord = z.infer<typeof SubmissionRecord>;
