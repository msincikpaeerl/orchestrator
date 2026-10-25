import { z } from 'zod';
import { requiredText } from '../text-limits.js';
import { Capability } from './capability.js';
import { message } from './envelope.js';
import { ClaudeSessionId, DaemonRunState, RunId } from './runs.js';

/** Operating system of a machine (01, section 3.8). */
export const MachineOs = z.enum(['linux', 'wsl']);
export type MachineOs = z.infer<typeof MachineOs>;

export { Capability } from './capability.js';

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

/**
 * The build identifier of a daemon package (05, section 2): 16 hexadecimal digits of a hash of
 * the bundled daemon, computed when the package is built (`apps/daemon/scripts/bundle.ts`).
 */
export const DaemonBuild = z.string().regex(/^[0-9a-f]{16}$/, 'must be 16 hexadecimal digits');
export type DaemonBuild = z.infer<typeof DaemonBuild>;

/** `hello`: the daemon's first message after connecting (05, section 3.3). */
export const Hello = message(
  'hello',
  z.object({
    /** Any version is readable here; the server decides whether it is compatible (09, section 6). */
    protocolVersion: z.int().positive(),
    daemonVersion: requiredText(),
    /**
     * The package's build identifier (protocol 2); null for a daemon run from its sources
     * (development, tests). Absent from a protocol 1 daemon.
     */
    daemonBuild: DaemonBuild.nullable().default(null),
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
 * `machine.doctor`: the checks again, when they change while connected (05, section 3.3): a run's
 * process scope could not be created, so the machine becomes unusable at once. Answered by an
 * `ack`; not kept for resending, since the next `hello` carries the same checks.
 */
export const MachineDoctor = message('machine.doctor', z.object({ doctor: z.array(DoctorCheck) }));
export type MachineDoctor = z.infer<typeof MachineDoctor>;

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
