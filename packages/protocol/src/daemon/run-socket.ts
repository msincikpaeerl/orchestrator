import { z } from 'zod';
import { McpToolName } from '../mcp/tools.js';
import { boundedText, requiredText } from '../text-limits.js';

// A run's socket, `runs/<run-id>/daemon.sock` (05, sections 4.2 and 4.5): the commands Claude Code
// runs for hooks and the status line send it their input, one JSON request per line, and print
// the answer. The inputs are Claude Code's own: they are read tolerantly (unknown fields kept,
// only the fields the daemon uses checked), since Claude Code adds fields between versions.

/** Hooks the daemon declares in each run's `settings.json` (05, section 4.5). */
export const HookEvent = z.enum([
  'SessionStart',
  // The launch's message taken (05, section 4.2.1; lot 5 step 5bis E).
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'StopFailure',
  'Notification',
  'SessionEnd',
]);
export type HookEvent = z.infer<typeof HookEvent>;

const HookBase = z.looseObject({
  session_id: z.string(),
  transcript_path: z.string().optional(),
  cwd: z.string().optional(),
});

/** The fields the daemon reads from each hook's input (Claude Code's hooks documentation). */
export const HookInputs = {
  SessionStart: HookBase.extend({
    source: z.string().optional(),
    model: z.string().optional(),
  }),
  UserPromptSubmit: HookBase.extend({ prompt: z.string().optional() }),
  PreToolUse: HookBase.extend({
    tool_name: z.string(),
    tool_input: z.unknown().optional(),
    tool_use_id: z.string().optional(),
  }),
  PostToolUse: HookBase.extend({
    tool_name: z.string(),
    tool_use_id: z.string().optional(),
  }),
  Stop: HookBase.extend({ last_assistant_message: z.string().optional() }),
  StopFailure: HookBase.extend({
    error: z.string().optional(),
    error_details: z.unknown().optional(),
    last_assistant_message: z.string().optional(),
  }),
  Notification: HookBase.extend({
    message: z.string().optional(),
    notification_type: z.string().optional(),
  }),
  SessionEnd: HookBase.extend({ reason: z.string().optional() }),
} as const satisfies Record<HookEvent, z.ZodType>;
export type HookInput<Event extends HookEvent> = z.infer<(typeof HookInputs)[Event]>;

const RateLimitWindow = z.looseObject({
  used_percentage: z.number().optional(),
  /** Unix seconds. */
  resets_at: z.number().optional(),
});

/** The status line command's input (05, section 4.5): only the fields the daemon reads. */
export const StatusLineInput = z.looseObject({
  session_id: z.string().optional(),
  cost: z.looseObject({ total_cost_usd: z.number().optional() }).optional(),
  rate_limits: z
    .looseObject({ five_hour: RateLimitWindow.optional(), seven_day: RateLimitWindow.optional() })
    .optional(),
});
export type StatusLineInput = z.infer<typeof StatusLineInput>;

/**
 * A request on a run's socket. `input` is checked by the daemon against `HookInputs`. `mcp` comes
 * from the run's MCP relay (06, section 1): the tool's wire name and its arguments as the agent
 * gave them, checked by the server only; the daemon adds the run token.
 */
export const RunSocketRequest = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hook'), event: HookEvent, input: z.unknown() }),
  z.object({ type: z.literal('status_line'), input: z.unknown() }),
  z.object({
    type: z.literal('mcp'),
    tool: z.string().max(200),
    arguments: z.record(z.string(), z.unknown()),
  }),
  /** The relay, at its start: the tools it lists, those of `run.start` (06, section 5). */
  z.object({ type: z.literal('tools') }),
]);
export type RunSocketRequest = z.infer<typeof RunSocketRequest>;

/** The daemon's answer to `tools`: the run's MCP tools (lot 3 step H). */
export const RunToolsAnswer = z.object({ tools: z.array(McpToolName) });
export type RunToolsAnswer = z.infer<typeof RunToolsAnswer>;

/** What the hook command prints for Claude Code (stdout), and its exit code. */
export const HookAnswer = z.object({
  stdout: boundedText(),
  exitCode: z.int().min(0).max(255),
});
export type HookAnswer = z.infer<typeof HookAnswer>;

/**
 * A request on the one-shot socket of a Git command (05, section 7), from the `git-credential`
 * helper: the key it was given and what Git asks for.
 */
export const CredentialSocketRequest = z.object({
  key: requiredText(),
  protocol: z.string(),
  host: z.string(),
  /** The repository path Git asks for (`credential.useHttpPath`), without the leading `/`. */
  path: z.string(),
});
export type CredentialSocketRequest = z.infer<typeof CredentialSocketRequest>;

export const CredentialSocketAnswer = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), username: requiredText(), password: requiredText() }),
  z.object({ ok: z.literal(false) }),
]);
export type CredentialSocketAnswer = z.infer<typeof CredentialSocketAnswer>;
