import { z } from 'zod';
import { boundedText, requiredText } from '../text-limits.js';
import { message } from './envelope.js';
import { ClaudeSessionId, DaemonRunState, RunId } from './runs.js';

/** Operating system of a machine (01, section 3.8). */
export const MachineOs = z.enum(['linux', 'wsl']);
export type MachineOs = z.infer<typeof MachineOs>;

/** A capability tag of a machine: `git`, `node`, `docker`, `android-sdk` (01, section 3.8). */
export const Capability = boundedText().regex(
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  'must be lowercase letters and digits, separated by "-"',
);
export type Capability = z.infer<typeof Capability>;

/** One result of `orchestrator-daemon doctor` (05, section 8). */
export const DoctorCheck = z.object({
  name: requiredText(),
  /** `check_yourself`: something the daemon cannot read, such as the Windows `.wslconfig`. */
  status: z.enum(['ok', 'warning', 'error', 'check_yourself']),
  message: requiredText(),
  /** Documentation explaining the check. */
  link: z.url().nullable(),
});
export type DoctorCheck = z.infer<typeof DoctorCheck>;

/** `hello`: the daemon's first message after connecting (05, section 3.3). */
export const Hello = message(
  'hello',
  z.object({
    /** Any version is readable here; the server decides whether it is compatible (09, section 6). */
    protocolVersion: z.int().positive(),
    daemonVersion: requiredText(),
    /** Null when `claude` is missing. */
    claudeCodeVersion: requiredText().nullable(),
    os: MachineOs,
    capabilities: z.array(Capability),
    doctor: z.array(DoctorCheck),
    /** Runs whose session or workspace is still on the machine (05, section 6). */
    runs: z.array(
      z.object({
        runId: RunId,
        state: DaemonRunState,
        claudeSessionId: ClaudeSessionId.nullable(),
      }),
    ),
  }),
);
export type Hello = z.infer<typeof Hello>;

/**
 * `welcome`: the server's answer to `hello`, with its id. When accepted, the heartbeat interval;
 * the run timeouts come with each `run.start`. When refused, the server then closes the
 * connection.
 */
export const Welcome = message(
  'welcome',
  z.discriminatedUnion('accepted', [
    z.object({
      accepted: z.literal(true),
      protocolVersion: z.int().positive(),
      heartbeatIntervalSeconds: z.int().positive(),
    }),
    z.object({
      accepted: z.literal(false),
      reason: z.enum(['protocol_incompatible', 'token_revoked']),
      /** What the owner should do, for `doctor` and the daemon's log. */
      message: requiredText(),
    }),
  ]),
);
export type Welcome = z.infer<typeof Welcome>;

/**
 * `heartbeat`: liveness only in lot 2. The resource summary comes with the scheduler (lot 4) as
 * an optional field, so protocol version 1 stays compatible (05, section 3.3).
 */
export const Heartbeat = message('heartbeat', z.object({}));
export type Heartbeat = z.infer<typeof Heartbeat>;
