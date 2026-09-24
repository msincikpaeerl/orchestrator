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
