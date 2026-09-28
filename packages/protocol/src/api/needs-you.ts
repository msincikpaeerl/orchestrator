import { z } from 'zod';
import { DoctorCheck } from '../daemon/connection.js';
import { ProjectKey, SetupStep } from './projects.js';

const MachineRef = z.object({ id: z.uuid(), name: z.string() });

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
]);
export type NeedsYouItem = z.infer<typeof NeedsYouItem>;

/** `GET /api/needs-you`: setup still to do first, then the other items oldest first. */
export const NeedsYouResponse = z.object({ items: z.array(NeedsYouItem) });
export type NeedsYouResponse = z.infer<typeof NeedsYouResponse>;
