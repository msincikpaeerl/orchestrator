import { z } from 'zod';
import { Capability, DoctorCheck, MachineOs } from '../daemon/connection.js';
import { requiredText } from '../text-limits.js';

/** Longest account label and machine name (01, sections 3.8 and 3.9). */
export const NAME_MAX_LENGTH = 80;

/** Plan of a Claude account: informational in v1 (01, section 3.9). */
export const AccountPlan = z.enum(['pro', 'max_5x', 'max_20x']);
export type AccountPlan = z.infer<typeof AccountPlan>;

/** `paused_manual` comes with lot 4; `limited` only for a usage limit detected with certainty. */
export const AccountState = z.enum(['available', 'paused_manual', 'limited']);
export type AccountState = z.infer<typeof AccountState>;

/** Range of an account's maximum concurrent runs: a field of the account, not a setting. */
export const MAX_CONCURRENT_RUNS = { min: 1, max: 10, default: 1 } as const;

export const MaxConcurrentRuns = z
  .int('must be a whole number of runs')
  .min(MAX_CONCURRENT_RUNS.min, `must be between 1 and ${String(MAX_CONCURRENT_RUNS.max)} runs`)
  .max(MAX_CONCURRENT_RUNS.max, `must be between 1 and ${String(MAX_CONCURRENT_RUNS.max)} runs`);

/** Account label or machine name: trimmed, unique among its kind without regard to case. */
export const DisplayName = requiredText(NAME_MAX_LENGTH);

/** A Claude account (01, section 3.9; 02, section 9.1). */
export const ClaudeAccount = z.object({
  id: z.uuid(),
  label: z.string(),
  plan: AccountPlan,
  maxConcurrentRuns: z.int(),
  state: AccountState,
  /** When `limited`: the expected reset time, when known. */
  limitedUntil: z.iso.datetime().nullable(),
  /** `limitedUntil` comes from the fallback delay: no reset time was known (07, section 5.2). */
  limitedUntilEstimated: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type ClaudeAccount = z.infer<typeof ClaudeAccount>;

/** `GET /api/accounts`: by label. */
export const AccountListResponse = z.object({ accounts: z.array(ClaudeAccount) });
export type AccountListResponse = z.infer<typeof AccountListResponse>;

/** `POST /api/accounts`. */
export const CreateAccountRequest = z.object({
  label: DisplayName,
  plan: AccountPlan,
  maxConcurrentRuns: MaxConcurrentRuns.default(MAX_CONCURRENT_RUNS.default),
});
export type CreateAccountRequest = z.input<typeof CreateAccountRequest>;

/** `PATCH /api/accounts/:id`: the fields to change. */
export const UpdateAccountRequest = z
  .object({ label: DisplayName, plan: AccountPlan, maxConcurrentRuns: MaxConcurrentRuns })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'nothing to change');
export type UpdateAccountRequest = z.infer<typeof UpdateAccountRequest>;

/**
 * The status label of a machine, derived from its fields in this order: revoked, waiting for
 * enrollment, disabled (with online or offline next to it), online, offline (02, section 9.2).
 */
export const MachineState = z.enum([
  'revoked',
  'waiting_enrollment',
  'disabled',
  'online',
  'offline',
]);
export type MachineState = z.infer<typeof MachineState>;

/**
 * One capability tag and where it comes from (01, section 3.8): `detected` by the daemon, `added`
 * or `removed` by the owner. `detected` also says whether the daemon reports it now, for the
 * notes "not detected" (added) and "detected" (removed).
 */
export const MachineCapability = z.object({
  tag: Capability,
  source: z.enum(['detected', 'added', 'removed']),
  detected: z.boolean(),
});
export type MachineCapability = z.infer<typeof MachineCapability>;

/** Why a machine cannot receive runs (01, section 3.8). */
export const UnusableReason = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('claude_code_unsupported'),
    /** Null when Claude Code is missing. */
    version: z.string().nullable(),
    minimum: z.string(),
  }),
  z.object({ type: z.literal('doctor_error'), check: DoctorCheck }),
]);
export type UnusableReason = z.infer<typeof UnusableReason>;

/** How the reported Claude Code version compares with the supported ones (05, section 2). */
export const ClaudeCodeSupportLevel = z.enum([
  'missing',
  'below_minimum',
  'supported',
  'above_validated',
]);

/** A machine (01, section 3.8; 02, section 9.2). Never includes its token or code. */
export const Machine = z.object({
  id: z.uuid(),
  name: z.string(),
  account: z.object({ id: z.uuid(), label: z.string() }),
  state: MachineState,
  /** Whether the daemon is connected now, shown next to **Disabled**. */
  online: z.boolean(),
  /** Everything below is reported by the daemon; null before its first connection. */
  os: MachineOs.nullable(),
  daemonVersion: z.string().nullable(),
  protocolVersion: z.int().nullable(),
  /** The last connection was refused for its protocol version: update the daemon. */
  daemonIncompatible: z.boolean(),
  /**
   * When the daemon is incompatible: the command installing the daemon of the server's version,
   * shown with the instruction to restart the daemon (02, section 4; 05, section 2).
   */
  updateCommand: z.string().nullable(),
  claudeCodeVersion: z.string().nullable(),
  claudeCodeSupport: ClaudeCodeSupportLevel.nullable(),
  lastHeartbeatAt: z.iso.datetime().nullable(),
  /** The machine's capabilities: detected and added, minus removed. */
  capabilities: z.array(Capability),
  /** Every tag with its source, for the capabilities editor. */
  capabilitySources: z.array(MachineCapability),
  doctor: z.array(DoctorCheck),
  /** Empty when the machine can receive runs (as far as its own checks go). */
  unusable: z.array(UnusableReason),
  enrolledAt: z.iso.datetime().nullable(),
  disabledAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  /** Expiry of the code a machine waiting for enrollment can use; null when none is valid. */
  enrollmentCodeExpiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type Machine = z.infer<typeof Machine>;

/** `GET /api/machines`: by name. */
export const MachineListResponse = z.object({ machines: z.array(Machine) });
export type MachineListResponse = z.infer<typeof MachineListResponse>;

/**
 * `GET /api/machines/server-address`: the address machines connect to, for **Add machine**'s
 * warning when a daemon would refuse it (plain `http://` outside this computer; 02, section 9.2).
 */
export const ServerAddressResponse = z.object({
  address: z.string(),
  refusedPlainHttp: z.boolean(),
});
export type ServerAddressResponse = z.infer<typeof ServerAddressResponse>;

/** `POST /api/machines`. */
export const CreateMachineRequest = z.object({ name: DisplayName, accountId: z.uuid() });
export type CreateMachineRequest = z.infer<typeof CreateMachineRequest>;

/**
 * A new enrollment code, shown once (02, section 9.2): the owner runs `installCommand` then
 * `enrollCommand` on the machine, before `expiresAt`.
 */
export const Enrollment = z.object({
  code: z.string(),
  expiresAt: z.iso.datetime(),
  installCommand: z.string(),
  enrollCommand: z.string(),
});
export type Enrollment = z.infer<typeof Enrollment>;

/** `POST /api/machines` and `POST /api/machines/:id/enrollment-code`. */
export const EnrollmentResponse = z.object({ machine: Machine, enrollment: Enrollment });
export type EnrollmentResponse = z.infer<typeof EnrollmentResponse>;

/**
 * `PUT /api/machines/:id/capabilities`: the tags the machine should have. The server keeps
 * where each comes from: a detected tag left out becomes removed, another tag becomes added.
 */
export const SetCapabilitiesRequest = z.object({
  capabilities: z
    .array(Capability)
    .max(50, 'at most 50 capabilities')
    .refine((tags) => new Set(tags).size === tags.length, 'each capability only once'),
});
export type SetCapabilitiesRequest = z.infer<typeof SetCapabilitiesRequest>;
