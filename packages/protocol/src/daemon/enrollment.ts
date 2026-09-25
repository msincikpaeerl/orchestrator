import { z } from 'zod';
import { PROTOCOL_VERSION } from '../version.js';

/**
 * Crockford's Base32 alphabet: digits and capital letters without `I`, `L`, `O` and `U`, so a code
 * read aloud or typed is never ambiguous (05, section 3.1).
 */
export const ENROLLMENT_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 24 characters of 5 bits: 120 random bits, impractical to guess within a code's lifetime. */
export const ENROLLMENT_CODE_LENGTH = 24;

/**
 * A one-time enrollment code as typed by the owner: any case, `-` and spaces ignored. Parsed to
 * the canonical form (capitals, no separators).
 */
export const EnrollmentCode = z
  .string()
  .max(100)
  .transform((value) => value.replace(/[-\s]/g, '').toUpperCase())
  .pipe(
    z
      .string()
      .length(ENROLLMENT_CODE_LENGTH, `must be ${String(ENROLLMENT_CODE_LENGTH)} characters`)
      .regex(/^[0-9A-HJKMNP-TV-Z]+$/, 'contains a character that is never in a code'),
  );
export type EnrollmentCode = z.infer<typeof EnrollmentCode>;

/** The long-lived machine token: `omt_` and 43 Base64 URL characters (256 random bits). */
export const MachineToken = z.string().regex(/^omt_[A-Za-z0-9_-]{43}$/, 'not a machine token');
export type MachineToken = z.infer<typeof MachineToken>;

/** `POST /daemon/enroll`: sent by `orchestrator-daemon enroll`, without authentication. */
export const EnrollRequest = z.object({ code: EnrollmentCode });
export type EnrollRequest = z.infer<typeof EnrollRequest>;

/** Answer to `POST /daemon/enroll`. The token is returned this once and stored hashed. */
export const EnrollResponse = z.object({
  machineId: z.uuid(),
  machineName: z.string(),
  machineToken: MachineToken,
});
export type EnrollResponse = z.infer<typeof EnrollResponse>;

/** Path of the daemon's WebSocket on the server (05, section 3.2). */
export const DAEMON_SOCKET_PATH = '/daemon';

/**
 * Whether the server accepts a daemon speaking `version`: the current protocol and the previous
 * one (09, section 6).
 */
export function isCompatibleProtocol(version: number): boolean {
  return version === PROTOCOL_VERSION || (version === PROTOCOL_VERSION - 1 && version >= 1);
}

/**
 * WebSocket close codes the server uses, so the daemon can tell why it was disconnected (05,
 * section 3.2). 4000 to 4999 are free for applications.
 */
export const DaemonCloseCode = {
  /** The machine was revoked, or the token is no longer valid: enroll again. */
  revoked: 4001,
  /** The daemon's protocol version is not accepted: update the daemon. */
  incompatible: 4002,
  /** A newer connection of the same machine replaced this one. */
  replaced: 4003,
  /** Nothing received for the "machine offline after" delay, or no `hello` in time. */
  silent: 4004,
  /** A message that is not valid JSON or does not match its schema. */
  invalidMessage: 4005,
  /** The server is shutting down. */
  shutdown: 4006,
} as const;
export type DaemonCloseCode = (typeof DaemonCloseCode)[keyof typeof DaemonCloseCode];
