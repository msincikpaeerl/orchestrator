import { createHash, randomBytes, randomInt } from 'node:crypto';
import { ENROLLMENT_CODE_ALPHABET, ENROLLMENT_CODE_LENGTH } from '@orchestrator/protocol';

// Enrollment codes and machine tokens (05, section 3.1). Both are random enough that a hash
// without salt is safe to store, and the database keeps nothing else.

/** A new one-time code: 24 characters of Crockford's Base32 (120 random bits). */
export function newEnrollmentCode(): string {
  let code = '';
  for (let index = 0; index < ENROLLMENT_CODE_LENGTH; index++) {
    code += ENROLLMENT_CODE_ALPHABET.charAt(randomInt(ENROLLMENT_CODE_ALPHABET.length));
  }
  return code;
}

/** A new machine token: `omt_` and 256 random bits in Base64 URL. */
export function newMachineToken(): string {
  return `omt_${randomBytes(32).toString('base64url')}`;
}

/** SHA-256 in hex: what the database keeps of a code or a token. */
export function hashCredential(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** `ABCD-EFGH-...`: the code in groups of four, easier to read on screen. */
export function formatEnrollmentCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, '$1-');
}
