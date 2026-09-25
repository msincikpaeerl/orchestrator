import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../version.js';
import {
  ENROLLMENT_CODE_ALPHABET,
  ENROLLMENT_CODE_LENGTH,
  EnrollmentCode,
  EnrollResponse,
  isCompatibleProtocol,
} from './enrollment.js';

describe('enrollment', () => {
  it('uses 32 unambiguous characters, 120 random bits per code', () => {
    expect(new Set(ENROLLMENT_CODE_ALPHABET).size).toBe(32);
    expect(ENROLLMENT_CODE_ALPHABET).not.toMatch(/[ILOU]/);
    expect(ENROLLMENT_CODE_LENGTH * Math.log2(ENROLLMENT_CODE_ALPHABET.length)).toBe(120);
  });

  it('reads a code in any case, with dashes and spaces', () => {
    expect(EnrollmentCode.parse('abcd-efgh-jkmn-pqrs-tvwx-yz01')).toBe('ABCDEFGHJKMNPQRSTVWXYZ01');
    expect(EnrollmentCode.parse(' ABCDEFGHJKMNPQRSTVWXYZ01 ')).toBe('ABCDEFGHJKMNPQRSTVWXYZ01');
  });

  it('refuses a code of the wrong length or with a letter never used', () => {
    expect(EnrollmentCode.safeParse('ABCDEFGH').success).toBe(false);
    expect(EnrollmentCode.safeParse('ABCDEFGHJKMNPQRSTVWXYZ0I').success).toBe(false);
  });

  it('accepts only a machine token of the documented form', () => {
    const answer = {
      machineId: '3f1e0e8c-1111-4000-8000-000000000000',
      machineName: 'Laptop',
      machineToken: `omt_${'a'.repeat(43)}`,
    };
    expect(EnrollResponse.safeParse(answer).success).toBe(true);
    expect(EnrollResponse.safeParse({ ...answer, machineToken: 'a'.repeat(47) }).success).toBe(
      false,
    );
  });

  it('accepts the current protocol version and the previous one, never 0', () => {
    expect(isCompatibleProtocol(PROTOCOL_VERSION)).toBe(true);
    expect(isCompatibleProtocol(PROTOCOL_VERSION + 1)).toBe(false);
    expect(isCompatibleProtocol(0)).toBe(false);
    expect(isCompatibleProtocol(PROTOCOL_VERSION - 1)).toBe(PROTOCOL_VERSION - 1 >= 1);
  });
});
