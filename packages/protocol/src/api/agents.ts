import { z } from 'zod';
import { boundedText } from '../text-limits.js';

/** Stable key of an agent profile: `architect`, `web_dev`, or a custom one (01, section 3.6). */
export const AgentKey = boundedText().regex(
  /^[a-z][a-z0-9_]*$/,
  'must start with a lowercase letter, then lowercase letters, digits and "_"',
);
export type AgentKey = z.infer<typeof AgentKey>;

/** Role of an agent profile; it sets the profile's MCP permissions (06, section 5). */
export const AgentRole = z.enum(['planner', 'builder', 'reviewer', 'writer']);
export type AgentRole = z.infer<typeof AgentRole>;

/** A profile as tickets name it: its key, and its name for the screens. */
export const AgentLink = z.object({ key: AgentKey, name: z.string() });
export type AgentLink = z.infer<typeof AgentLink>;

/** An agent profile as the screens list it (01, section 3.6). */
export const AgentProfileSummary = AgentLink.extend({
  description: z.string(),
  role: AgentRole,
  /** Claude Code's model name or alias, such as `sonnet`. */
  model: z.string(),
  /** Raised when the profile's instructions change (03, section 3). */
  version: z.int().positive(),
});
export type AgentProfileSummary = z.infer<typeof AgentProfileSummary>;

/** `GET /api/agents`: every profile, by name. */
export const AgentListResponse = z.object({ agents: z.array(AgentProfileSummary) });
export type AgentListResponse = z.infer<typeof AgentListResponse>;

/**
 * Largest filled-in first message of a run, in UTF-8 bytes (03, section 3.2). It is passed to
 * Claude Code as one command-line argument, which Linux caps at 128 KiB (`MAX_ARG_STRLEN`): a
 * constant from the operating system, not a setting. 100,000 bytes leaves a margin under that cap
 * and never exceeds the 100,000 characters of the protocol's text ceiling.
 */
export const FIRST_MESSAGE_MAX_BYTES = 100_000;
