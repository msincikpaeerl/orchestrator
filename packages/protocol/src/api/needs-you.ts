import { z } from 'zod';
import { DoctorCheck } from '../daemon/connection.js';
import { AgentLink } from './agents.js';
import { ClaudeAccount } from './machines.js';
import { ProjectKey, SetupStep } from './projects.js';
import { Run } from './runs.js';
import { Comment } from './tickets.js';

const MachineRef = z.object({ id: z.uuid(), name: z.string() });
const TicketRef = z.object({ projectKey: ProjectKey, number: z.int(), title: z.string() });

/**
 * One item of "Needs you" (02, section 4), besides the GitHub connection problems of
 * `GET /api/github`. Each lot adds its own types.
 */
export const NeedsYouItem = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('project_setup_failed'),
    project: z.object({ key: ProjectKey, name: z.string() }),
    step: SetupStep,
    reason: z.string(),
    since: z.iso.datetime(),
  }),
  /** Setup still to do (02, section 3): no Claude account exists. */
  z.object({ type: z.literal('no_claude_account') }),
  /** Setup still to do: no machine is enrolled and not revoked. */
  z.object({ type: z.literal('no_machine') }),
  /** The daemon's protocol version is refused: update the daemon (05, section 3.2). */
  z.object({
    type: z.literal('daemon_incompatible'),
    machine: MachineRef,
    daemonVersion: z.string().nullable(),
    protocolVersion: z.int().nullable(),
    /** Installs the daemon of the server's version; then the daemon is restarted. */
    updateCommand: z.string(),
    since: z.iso.datetime(),
  }),
  /** Claude Code missing or below the minimum: the machine is unusable. */
  z.object({
    type: z.literal('claude_code_unsupported'),
    machine: MachineRef,
    version: z.string().nullable(),
    minimum: z.string(),
    since: z.iso.datetime(),
  }),
  /** `doctor` reports an error: the machine is unusable. */
  z.object({
    type: z.literal('machine_problem'),
    machine: MachineRef,
    checks: z.array(DoctorCheck),
    since: z.iso.datetime(),
  }),
  /**
   * A machine offline while runs are active on it (02, section 4): they show "machine offline",
   * and **Stop run** fails them with `machine_offline` (05, section 6).
   */
  z.object({
    type: z.literal('machine_offline_with_runs'),
    machine: MachineRef,
    /** The tickets of its active runs (`WEB-12`). */
    tickets: z.array(z.string()),
    /** The last message received from it. */
    since: z.iso.datetime(),
  }),
  /** An agent's open question, answered with the same answer box as the ticket page (04, section 6). */
  z.object({
    type: z.literal('question'),
    ticket: TicketRef,
    question: Comment,
    /** When it was asked. */
    since: z.iso.datetime(),
  }),
  /** A ticket an agent created with `ticket_create`: **Accept** or **Reject** (04, section 2). */
  z.object({
    type: z.literal('ticket_proposed'),
    ticket: TicketRef,
    agent: AgentLink.nullable(),
    /** When it was created. */
    since: z.iso.datetime(),
  }),
  /**
   * Work finished by an agent (`in_review` in lot 2, 04 section 1): **Mark as done manually** or
   * **Request changes**, judged from the run's summary.
   */
  z.object({
    type: z.literal('work_to_check'),
    ticket: TicketRef,
    /** The summary of the accepted submission; null if none was stored. */
    summary: z.string().nullable(),
    /** The run that submitted it. */
    runId: z.uuid().nullable(),
    /** When it was submitted. */
    since: z.iso.datetime(),
  }),
  /** A run paused on a usage limit, detected or suspected: **Resume** or **Stop run**. */
  z.object({
    type: z.literal('run_paused'),
    run: Run,
    ticket: TicketRef,
    /** When it paused. */
    since: z.iso.datetime(),
  }),
]);
export type NeedsYouItem = z.infer<typeof NeedsYouItem>;

/**
 * The compact status line of a Claude account (02, section 4): in lot 2 "Available" or "Limited
 * until <time>", a limit whose time has passed shown available.
 */
export const AccountStatus = ClaudeAccount.pick({
  id: true,
  label: true,
  state: true,
  limitedUntil: true,
  limitedUntilEstimated: true,
});
export type AccountStatus = z.infer<typeof AccountStatus>;

/**
 * `GET /api/needs-you`: setup still to do first, then the other items oldest first (by when their
 * reason began), and the status line of each Claude account, by label.
 */
export const NeedsYouResponse = z.object({
  items: z.array(NeedsYouItem),
  accounts: z.array(AccountStatus),
});
export type NeedsYouResponse = z.infer<typeof NeedsYouResponse>;
