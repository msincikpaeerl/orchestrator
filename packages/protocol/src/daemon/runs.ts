import { z } from 'zod';
import { AgentKey, FIRST_MESSAGE_MAX_BYTES } from '../api/agents.js';
import { RepositoryName } from '../api/projects.js';
import { TicketReference } from '../api/tickets.js';
import { boundedText, requiredText, settingCeiling } from '../text-limits.js';
import { message } from './envelope.js';
import { END_REPORT_TEXT_MAX_CHARACTERS, cutText } from './budgets.js';
import { BranchReport, GitBranchName, PushResult, RepositoryOwner } from './git.js';

export const RunId = z.uuid();
export type RunId = z.infer<typeof RunId>;

/** Claude Code's session id, used to resume a closed session (05, section 4.3). */
export const ClaudeSessionId = z.uuid();
export type ClaudeSessionId = z.infer<typeof ClaudeSessionId>;

/** Why a run exists (01, section 3.7). */
export const RunPurpose = z.enum(['implement', 'review', 'plan', 'document', 'fix_review']);
export type RunPurpose = z.infer<typeof RunPurpose>;

/** States of a run on the daemon (05, section 4.7); the server maps them to run statuses. */
export const DaemonRunState = z.enum([
  'preparing',
  'starting',
  'working',
  'idle',
  'waiting_ci',
  'waiting_human',
  'quota_paused',
  'ended',
]);
export type DaemonRunState = z.infer<typeof DaemonRunState>;

/**
 * Why a run ended on the daemon: a fact, never a ticket decision. The server derives the run's
 * status and failure reason from it (05, section 4.7; 01, section 3.7).
 */
export const RunEndReason = z.enum([
  /** The agent's `ticket_submit` was accepted, then its turn ended. */
  'submitted',
  /** The agent called `ticket_give_up`. */
  'gave_up',
  /** The turn ended without a decision after the maximum number of nudges (05, section 4.8). */
  'nudges_exhausted',
  /** `run.stop` from the server. */
  'stopped',
  /** The maximum run duration was reached (05, section 5). */
  'max_duration',
  /** The idle timeout was reached after the nudges (05, section 5). */
  'idle_timeout',
  /** No `SessionStart` within the session start timeout (05, section 4.2.1). */
  'session_start_timeout',
  /**
   * The `claude` about to be launched is missing or older than the minimum, so it was not
   * launched (05, section 4.3): a machine problem, never a failed attempt.
   */
  'claude_code_unsupported',
  /**
   * systemd-run refused the run's process scope or the tmux server's (05, section 2): Claude Code
   * never started, and the daemon takes no more runs until restarted. A machine problem, never a
   * failed attempt.
   */
  'process_scope_failed',
  /** The workspace could not be prepared, or the session ended unexpectedly. */
  'crashed',
  /** One CI failure more than **Most CI failures per run** (04, section 3.1; protocol 2). */
  'ci_failed',
  /** **CI wait at submission** reached while waiting for CI (04, section 3.1; protocol 2). */
  'ci_timeout',
  /** The branch head moved during a review run (04, section 3.2; protocol 2). */
  'review_branch_moved',
  /**
   * The push at a `ticket_submit` failed (refused, diverged or GitHub unreachable): the run ends
   * at the turn's end, since the agent cannot fix it (04, section 3.1; lot 3 step F).
   */
  'push_failed',
]);
export type RunEndReason = z.infer<typeof RunEndReason>;

/**
 * Where the daemon clones from: `https`, or `http` and `file` for local test remotes. It never
 * holds a credential (05, section 7): the token comes through `git.credential` only.
 */
export const CloneUrl = requiredText().refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return ['https:', 'http:', 'file:'].includes(url.protocol) && !url.username && !url.password;
}, 'must be an https, http or file URL without credentials');

/** Resolved when the run starts (04, section 8; 05, section 5). */
export const RunLimits = z.object({
  maxRunDurationMinutes: z.int().positive(),
  idleTimeoutMinutes: z.int().positive(),
  maxNudgesPerRun: z.int().min(0),
  waitingRunLifetimeMinutes: z.int().positive(),
  sessionStartTimeoutSeconds: z.int().positive(),
  mcpCallTimeoutSeconds: z.int().positive(),
  claudeCodeMcpToolTimeoutSeconds: z.int().positive(),
  /** **Longest push**: every fetch and push of the run (protocol 2, lot 3 step D). */
  pushTimeoutSeconds: z.int().positive(),
});
export type RunLimits = z.infer<typeof RunLimits>;

/** `run.start`, server to daemon (05, section 4.1). */
export const RunStart = message(
  'run.start',
  z.object({
    runId: RunId,
    purpose: RunPurpose,
    /** A ticket, or a request for planning runs. */
    subject: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('ticket'), id: z.uuid(), number: TicketReference }),
      z.object({ kind: z.literal('request'), id: z.uuid() }),
    ]),
    repository: z.object({
      owner: RepositoryOwner,
      name: RepositoryName,
      cloneUrl: CloneUrl,
      baseBranch: GitBranchName,
      ticketBranch: GitBranchName,
    }),
    /** Set for the worktree (04, section 4). */
    commitAuthor: z.object({ name: requiredText(), email: z.email() }),
    profile: z.object({
      key: AgentKey,
      version: z.int().positive(),
      instructions: requiredText(),
      model: requiredText(),
      /** Claude Code permission rules, such as `Bash(pnpm test *)`. */
      allowedTools: z.array(requiredText()),
    }),
    /** Scoped to this run; carried by every `mcp.call` (06, section 2). */
    runToken: requiredText(),
    /**
     * First message, built by the server (06, section 6). Passed as one command-line argument, so
     * it fits `FIRST_MESSAGE_MAX_BYTES` (03, section 3.2).
     */
    initialPrompt: requiredText().refine(
      (text) => new TextEncoder().encode(text).length <= FIRST_MESSAGE_MAX_BYTES,
      `at most ${String(FIRST_MESSAGE_MAX_BYTES)} bytes`,
    ),
    /**
     * Sent by the daemon when a turn ends without a decision (05, section 4.8). Filled in by the
     * server from its run message template: the daemon holds no agent-facing text (03, section 3.2).
     */
    nudgeMessage: requiredText(),
    limits: RunLimits,
    /** A Claude session to resume instead of starting a new one. */
    resumeSessionId: ClaudeSessionId.nullable(),
  }),
);
export type RunStart = z.infer<typeof RunStart>;

/**
 * `run.input`: text for a live session (owner answer, CI result), 05 section 4.4. Built from a run
 * message template in `agents/` (03, section 3.2). Nudges come with `run.start`, not this way.
 */
/**
 * Text of `run.input`: the owner's answer is sent whole with the question it answers (03, section
 * 3.2), each up to the longest comment, plus the template's own words.
 */
const RUN_INPUT_CEILING = 2 * settingCeiling('commentMaxLength') + 10_000;

/**
 * `fetchBase` (lot 3 step G2a): the daemon downloads the base branch from GitHub before it gives
 * the text, through the isolated fetch of 05 section 7.1, and acknowledges only afterwards; a
 * failed download refuses the message, which then never reaches the agent. Only a run waiting
 * for CI takes it: the message telling the agent to merge the base branch after a conflict.
 * A yes or no, never a branch or a URL: the base branch is `run.start`'s.
 */
const FetchBase = z.boolean().optional();

/**
 * The daemon's refusal of a `run.input` whose session is closed (05, section 4.4), and of a
 * `run.resume` whose session is still alive: the server then sends the other one (a CI round,
 * lot 3 step G2b; an answer, lot 2 step K).
 */
export const SESSION_CLOSED_REFUSAL = 'session closed: use run.resume';
export const SESSION_ALIVE_REFUSAL = 'The session is still running.';

export const RunInput = message(
  'run.input',
  z.object({ runId: RunId, text: requiredText(RUN_INPUT_CEILING), fetchBase: FetchBase }),
);
export type RunInput = z.infer<typeof RunInput>;

/**
 * `run.resume`: start a closed session again, after a usage-limit pause, when the owner answers
 * after the waiting run lifetime (04, section 6), or to give a CI result to a run waiting for CI
 * whose session closed (lot 3 step G2). `message` is the first message after
 * `--resume`: the answer, or the message asking the agent to continue, both built from run message
 * templates in `agents/` (03, section 3.2).
 */
export const RunResume = message(
  'run.resume',
  z.object({
    runId: RunId,
    claudeSessionId: ClaudeSessionId,
    /** A command-line argument, like the first message: within `FIRST_MESSAGE_MAX_BYTES`. */
    message: requiredText().refine(
      (text) => new TextEncoder().encode(text).length <= FIRST_MESSAGE_MAX_BYTES,
      `at most ${String(FIRST_MESSAGE_MAX_BYTES)} bytes`,
    ),
    fetchBase: FetchBase,
  }),
);
export type RunResume = z.infer<typeof RunResume>;

/** `run.stop`: end a run (04, section 2; 05, section 6). */
export const RunStop = message(
  'run.stop',
  z.object({
    runId: RunId,
    reason: z.enum([
      /** The owner's **Stop run**. */
      'owner_stopped',
      'ticket_cancelled',
      /** Reported alive by the daemon, but no longer active on the server. */
      'not_active',
      /**
       * The run waits for CI and CI passed: it ends with `submitted` (05, section 4.9; protocol 2).
       */
      'completed',
    ]),
  }),
);
export type RunStop = z.infer<typeof RunStop>;

const RunStateBase = z.object({
  runId: RunId,
  at: z.iso.datetime(),
  /** Known from `SessionStart`; null before. */
  claudeSessionId: ClaudeSessionId.nullable(),
  /** Whether the tmux session is running: false once a waiting or paused run's session is closed. */
  sessionAlive: z.boolean(),
});

/** `run.state`: the run's daemon state changed (05, section 4.7). */
export const RunState = message(
  'run.state',
  z.discriminatedUnion('state', [
    RunStateBase.extend({ state: DaemonRunState.exclude(['starting', 'ended']) }),
    RunStateBase.extend({
      state: z.literal('starting'),
      /**
       * `claude --version` of the executable about to be launched, null when it is missing: the
       * server checks it again at each run start (05, section 4.3).
       */
      claudeCodeVersion: requiredText().nullable(),
    }),
    RunStateBase.extend({
      state: z.literal('ended'),
      reason: RunEndReason,
      /**
       * Plain-words detail for the event log ("workspace trust or startup dialog suspected"), cut
       * at `END_REPORT_TEXT_MAX_CHARACTERS` (lot 3 step F; cut, not refused, from a 0.3.0 daemon).
       */
      detail: boundedText()
        .transform((detail) => cutText(detail, END_REPORT_TEXT_MAX_CHARACTERS))
        .nullable(),
      /** The ticket branch at the end; null when no worktree was created. */
      branch: BranchReport.nullable(),
      /**
       * The best-effort push of an `implement` or `fix_review` run ending with commits not on
       * GitHub (05, section 4.11; protocol 2); null when none was tried. Absent from protocol 1.
       */
      push: PushResult.nullable().default(null),
      /**
       * A `review` run: whether the branch head moved during the review (04, section 3.2;
       * protocol 2). Null for other runs, and absent from protocol 1.
       */
      headMoved: z.boolean().nullable().default(null),
      /**
       * What the daemon found changed in the bare clone's Git configuration and hooks at the
       * run's end, and restored, in plain words: the settings and hook files named, never their
       * values or content (05, section 7.1; protocol 2). Null when nothing changed, and absent
       * from protocol 1.
       */
      gitConfigRestored: boundedText(END_REPORT_TEXT_MAX_CHARACTERS).nullable().default(null),
    }),
  ]),
);
export type RunState = z.infer<typeof RunState>;

/** One live log entry from the transcript (02, section 7), with credentials already masked. */
export const RunLogEvent = z.object({
  /** Position in the run's log, from 0: the server stores each position once. */
  seq: z.int().min(0),
  at: z.iso.datetime(),
  kind: z.enum([
    /** The agent's text. */
    'agent_text',
    /** A tool call, with its name and a short input. */
    'tool_call',
    'tool_result',
    /** A message sent to the agent: first message, answer, nudge. */
    'input',
    /** Something the daemon could not show, such as transcript lines it skipped (05, section 4.5). */
    'warning',
  ]),
  /** Tool name for `tool_call` and `tool_result`. */
  tool: boundedText().nullable(),
  text: boundedText(),
});
export type RunLogEvent = z.infer<typeof RunLogEvent>;

/** `run.events`: a batch of log entries, acknowledged as a whole. */
export const RunEvents = message(
  'run.events',
  z.object({
    runId: RunId,
    events: z.array(RunLogEvent).min(1),
    /** Latest estimated usage in US dollars (05, section 4.5); null when unknown. */
    estimatedUsageUsd: z.number().min(0).nullable(),
  }),
);
export type RunEvents = z.infer<typeof RunEvents>;

/** `error` of Claude Code's `StopFailure` hook; `unknown` also stands for any undocumented value. */
export const StopFailureError = z.enum([
  'rate_limit',
  'overloaded',
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'billing_error',
  'invalid_request',
  'model_not_found',
  'server_error',
  'max_output_tokens',
  'cloud_credential_error',
  'unknown',
]);
export type StopFailureError = z.infer<typeof StopFailureError>;

/** What made the daemon detect or suspect a usage limit (05, section 4.10). */
export const QuotaEvidence = z.object({
  signal: z.enum([
    /** A `StopFailure` hook. */
    'stop_failure',
    /** A turn ending on an API error text, with no tool use. */
    'api_error_turn',
    /** The idle timeout right after such a turn. */
    'idle_after_api_error',
  ]),
  /** The `StopFailure` error type, for `stop_failure`. */
  error: StopFailureError.nullable(),
  /** The error text shown by Claude Code (`last_assistant_message`). */
  message: boundedText().nullable(),
  /** The latest status line window, when one was received (supplementary, 05 section 4.10). */
  statusLine: z
    .object({
      window: z.enum(['five_hour', 'seven_day']),
      usedPercentage: z.number().min(0),
      resetsAt: z.iso.datetime().nullable(),
    })
    .nullable(),
});
export type QuotaEvidence = z.infer<typeof QuotaEvidence>;

/** `run.quota_limited`: the session was closed on a usage limit, detected or suspected. */
export const RunQuotaLimited = message(
  'run.quota_limited',
  z.discriminatedUnion('kind', [
    z.object({
      runId: RunId,
      kind: z.literal('detected'),
      /** From the status line, else from the message; null when neither gives it. */
      resetsAt: z.iso.datetime().nullable(),
      evidence: QuotaEvidence,
    }),
    z.object({ runId: RunId, kind: z.literal('suspected'), evidence: QuotaEvidence }),
  ]),
);
export type RunQuotaLimited = z.infer<typeof RunQuotaLimited>;
