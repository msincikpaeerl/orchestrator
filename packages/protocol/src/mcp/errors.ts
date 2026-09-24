import { z } from 'zod';
import { SettingName } from '../api/settings.js';
import { boundedText, requiredText } from '../text-limits.js';

/** Error codes of every MCP tool (06, section 3). */
export const McpErrorCode = z.enum([
  /** The profile does not have this permission, or the object belongs to another ticket. */
  'FORBIDDEN',
  /** Unknown object in this project. */
  'NOT_FOUND',
  /** The ticket's state does not allow this action (04). */
  'INVALID_TRANSITION',
  /** Input incomplete or inconsistent; the details list the problems. */
  'VALIDATION_FAILED',
  /** Submission checks failed; the details list each failed check. */
  'DOD_FAILED',
  /** A configurable limit was hit (04, section 8). */
  'LIMIT_REACHED',
  /** The daemon is disconnected from the server, or the server did not answer in time. */
  'UNAVAILABLE',
]);
export type McpErrorCode = z.infer<typeof McpErrorCode>;

/** Checks of the lot 2 submission (04, section 3.1), named in `DOD_FAILED` details. */
export const DodCheck = z.enum(['criteria_met', 'worktree_clean', 'commits_ahead']);
export type DodCheck = z.infer<typeof DodCheck>;

/** One problem of a refused call, written for the agent. */
export const McpErrorDetail = z.object({
  message: requiredText(),
  /** `VALIDATION_FAILED`: the input field at fault (`criteria.0.status`). */
  field: boundedText().optional(),
  /** `DOD_FAILED`: the failed check. */
  check: DodCheck.optional(),
  /** `LIMIT_REACHED`: the setting whose limit was hit. */
  setting: SettingName.optional(),
});
export type McpErrorDetail = z.infer<typeof McpErrorDetail>;

/**
 * A refused tool call: a code, a message written for the agent, and details when useful. A
 * refusal tied to a setting states the setting's current value in its message ("limit of 3
 * tickets per run reached"), 06 section 3.
 */
export const McpError = z.object({
  code: McpErrorCode,
  message: requiredText(),
  details: z.array(McpErrorDetail).optional(),
});
export type McpError = z.infer<typeof McpError>;
