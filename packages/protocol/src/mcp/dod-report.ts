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

/**
 * One submission check's result (04, section 3.1; lot 3 step F): `incomplete` when the server
 * could not fully do it (the machine's list of changed files was cut, or not sent), which never
 * refuses a submission; `skipped` when an earlier check made it pointless (no push is tried on a
 * worktree with uncommitted changes). `messages` are the texts the agent received, or for an
 * incomplete check what could not be done.
 */
export const DodCheckResult = z.object({
  check: DodCheck,
  result: z.enum(['passed', 'failed', 'incomplete', 'skipped']),
  messages: z.array(z.string()),
});
export type DodCheckResult = z.infer<typeof DodCheckResult>;

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
});
export type SubmissionRecord = z.infer<typeof SubmissionRecord>;
