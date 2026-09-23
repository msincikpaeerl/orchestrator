import { z } from 'zod';

/**
 * Branch protection of a project's default branch (01, section 3.1; 08, section 3.1).
 * `not_available`: the owner's GitHub plan does not offer it for this repository.
 * `not_applied`: a linked repository, which the Orchestrator never changes.
 */
export const BranchProtection = z.enum(['applied', 'not_available', 'failed', 'not_applied']);
export type BranchProtection = z.infer<typeof BranchProtection>;

/** Harness elements looked for in a linked repository, in the order of 08, section 3.4. */
export const HarnessElement = z.enum(['claude_md', 'user_docs', 'dev_docs', 'adrs', 'ci_workflow']);
export type HarnessElement = z.infer<typeof HarnessElement>;
