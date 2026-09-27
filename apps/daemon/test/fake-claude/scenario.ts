import { z } from 'zod';

// The scenario a fake `claude` plays (ADR 0027): what it does at startup and in each turn. A test
// writes it as JSON in the fake's folder, as `scenario.json`, or as `scenarios/<run id>.json` for
// the session whose worktree is named after that run.

const JsonObject = z.record(z.string(), z.unknown());

/** One thing the fake does during a turn, in order. */
export const Step = z.discriminatedUnion('do', [
  /** The agent's text: a transcript entry, and the turn's last message. */
  z.object({ do: z.literal('text'), text: z.string() }),
  /** A tool call that is not run: its hooks and transcript entries only. */
  z.object({
    do: z.literal('tool'),
    name: z.string(),
    input: JsonObject.default({}),
    result: z.string().default(''),
  }),
  /** A `Bash` tool call run for real in the working directory (to make commits, for example). */
  z.object({ do: z.literal('bash'), command: z.string() }),
  /** A call to a tool of the MCP server declared in `--mcp-config`, started on first use. */
  z.object({ do: z.literal('mcp'), tool: z.string(), arguments: JsonObject.default({}) }),
  /** Runs the status line command with this input (added to the session's fields). */
  z.object({ do: z.literal('statusLine'), input: JsonObject }),
  z.object({
    do: z.literal('notification'),
    type: z.string().default('idle_prompt'),
    message: z.string().default('Claude is waiting for your input'),
  }),
  /** A raw transcript line, such as a malformed or unknown one. */
  z.object({ do: z.literal('transcript'), line: z.string() }),
  /** An API error shown as the turn's text, as Claude Code writes it (a usage-limit signal). */
  z.object({ do: z.literal('apiError'), text: z.string() }),
  z.object({ do: z.literal('sleep'), ms: z.int().min(0) }),
  /** Never ends the turn: a session that hangs. */
  z.object({ do: z.literal('hang') }),
  /** Ends the session, after its `SessionEnd` hook. */
  z.object({ do: z.literal('exit'), code: z.int().default(0) }),
]);
export type Step = z.infer<typeof Step>;

/** How a turn ends: `Stop`, or `StopFailure` with an API error type and text. */
export const TurnEnd = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stop') }),
  z.object({ kind: z.literal('stopFailure'), error: z.string(), message: z.string() }),
]);
export type TurnEnd = z.infer<typeof TurnEnd>;

export const Turn = z.object({
  steps: z.array(Step).default([]),
  end: TurnEnd.default({ kind: 'stop' }),
});
export type Turn = z.infer<typeof Turn>;

export const Scenario = z.object({
  /** What `claude --version` prints. */
  version: z.string().default('2.1.282 (Claude Code)'),
  /** Wait before the `SessionStart` hook. */
  startDelayMs: z.int().min(0).default(0),
  /** Never runs `SessionStart`, as when a startup dialog waits for a key. */
  noSessionStart: z.boolean().default(false),
  /**
   * Turn `n` answers the `n`-th message: the first message (after `--`) is turn 0, each message
   * typed or pasted in the terminal the next one. Later messages get a turn saying "Done.".
   */
  turns: z.array(Turn).default([]),
});
export type Scenario = z.infer<typeof Scenario>;
export type ScenarioInput = z.input<typeof Scenario>;

/** What the fake records in `log.jsonl`, one line per fact, for the tests to check. */
export type FakeLogEntry =
  | {
      event: 'start';
      pid: number;
      args: string[];
      cwd: string;
      env: { CLAUDE_CONFIG_DIR: string | null; TMUX: string | null; TMUX_PANE: string | null };
    }
  | { event: 'arguments_refused'; message: string }
  | { event: 'message'; text: string }
  | { event: 'hook'; hook: string; exitCode: number; stdout: string }
  | { event: 'denied'; tool: string; reason: string }
  | { event: 'mcp_tools'; tools: { name: string; inputSchema: unknown }[] }
  | { event: 'mcp'; tool: string; result: unknown }
  | { event: 'bash'; command: string; exitCode: number; output: string }
  | { event: 'exit'; code: number };
