import { ApiErrorCode, CheckCiAgainRefusal } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './api';
import { refusalText, UNEXPECTED_TEXT } from './refusals';

describe('refusalText', () => {
  // Every code of packages/protocol: a new code without its own text fails here.
  it.each(ApiErrorCode.options)('has its own plain-words text for %s', (code) => {
    const text = refusalText(new ApiRequestError(409, code, 'message for developers'));
    expect(text).not.toBe(UNEXPECTED_TEXT);
    expect(text).not.toContain(code);
    expect(text).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
    expect(text).toMatch(/^[A-Z].*[.!?]$/);
  });

  it('says why Check CI again was refused, with its facts (lot 3 step G2c)', () => {
    const refused = (ciRefusal: NonNullable<ApiRequestError['ciRefusal']>) =>
      refusalText(
        // prettier-ignore
        new ApiRequestError(409, 'ci_check_refused', 'x', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, ciRefusal),
      );
    for (const reason of CheckCiAgainRefusal.options) {
      const text = refused({
        reason,
        commit: 'a'.repeat(40),
        head: 'b'.repeat(40),
        pullRequest: 12,
      });
      expect(text).toMatch(/^[A-Z].*[.!?]$/);
      expect(text).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
    }
    expect(refused({ reason: 'branch_moved', commit: 'a'.repeat(40), head: 'b'.repeat(40) })).toBe(
      'The branch changed on GitHub after commit aaaaaaa (it is now bbbbbbb), so this result would not be about the latest work. Run now hands the work in again.',
    );
    expect(refused({ reason: 'pull_request_merged', pullRequest: 12 })).toBe(
      'Pull request #12 was merged on GitHub. Use Mark as done manually.',
    );
  });

  it('says when the Orchestrator cannot be reached, without a code', () => {
    expect(refusalText(new ApiRequestError(0, 'unexpected', 'x'))).toBe(
      'The Orchestrator could not be reached. Try again.',
    );
    expect(refusalText(new ApiRequestError(500, 'unexpected', 'x'))).toBe(UNEXPECTED_TEXT);
    expect(refusalText(new Error('x'))).toBe(UNEXPECTED_TEXT);
  });

  it('names each field over its limit, and the limit', () => {
    const error = new ApiRequestError(400, 'invalid_request', 'x', undefined, [
      { field: 'title', max: 200, unit: 'characters' },
      { field: 'description', max: 20_000, unit: 'characters' },
      { field: 'acceptance_criteria', max: 20, unit: 'items' },
      { field: 'acceptance_criterion', index: 2, max: 500, unit: 'characters' },
      { field: 'comment', max: 20_000, unit: 'characters' },
    ]);
    expect(refusalText(error)).toBe(
      'The title can have at most 200 characters. The description can have at most 20,000 characters. A ticket can have at most 20 acceptance criteria. Acceptance criterion 3 can have at most 500 characters. A comment can have at most 20,000 characters.',
    );
  });

  it('names both settings and their values when two limits would be out of order', () => {
    const error = new ApiRequestError(
      409,
      'setting_order_invalid',
      'x',
      undefined,
      undefined,
      undefined,
      {
        smaller: 'quotaFallbackDelayMinutes',
        larger: 'quotaFallbackMaxDelayMinutes',
        smallerValue: 300,
        largerValue: 240,
        factor: 1,
        strict: false,
      },
    );
    expect(refusalText(error)).toBe(
      'Longest quota wait (240 minutes) cannot be less than Quota wait when the reset time is unknown (300 minutes). Change the other one first, or choose another value.',
    );
  });

  it('names the three settings of a sum that must stay below a third one', () => {
    const error = new ApiRequestError(
      409,
      'setting_sum_invalid',
      'x',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        parts: [
          { name: 'mcpCallTimeoutSeconds', value: 30 },
          { name: 'pushTimeoutSeconds', value: 90 },
        ],
        below: { name: 'claudeCodeMcpToolTimeoutSeconds', value: 120 },
      },
    );
    expect(refusalText(error)).toBe(
      'MCP call timeout (30 seconds) plus Longest push (90 seconds) must be less than Claude Code MCP tool timeout (120 seconds). Change one of them first, or choose another value.',
    );
  });

  it('states the rule of a pair that must be at least twice the other', () => {
    const error = new ApiRequestError(
      409,
      'setting_order_invalid',
      'x',
      undefined,
      undefined,
      undefined,
      {
        smaller: 'heartbeatIntervalSeconds',
        larger: 'machineOfflineAfterSeconds',
        smallerValue: 20,
        largerValue: 30,
        factor: 2,
        strict: false,
      },
    );
    expect(refusalText(error)).toBe(
      'Machine offline after (30 seconds) must be at least twice Heartbeat interval (20 seconds). Change the other one first, or choose another value.',
    );
  });

  it('states the rule of a pair where one must stay strictly below the other', () => {
    const error = new ApiRequestError(
      409,
      'setting_order_invalid',
      'x',
      undefined,
      undefined,
      undefined,
      {
        smaller: 'loginFirstDelaySeconds',
        larger: 'loginMaxDelaySeconds',
        smallerValue: 30,
        largerValue: 30,
        factor: 1,
        strict: true,
      },
    );
    expect(refusalText(error)).toBe(
      'Longest login delay (30 seconds) must be more than First login delay (30 seconds). Change the other one first, or choose another value.',
    );
  });

  it('states the current enrollment code lifetime when a code expired', () => {
    const error = new ApiRequestError(
      410,
      'enrollment_code_expired',
      'x',
      undefined,
      undefined,
      undefined,
      undefined,
      { name: 'enrollmentCodeLifetimeMinutes', value: 20 },
    );
    expect(refusalText(error)).toBe(
      'This enrollment code expired: codes are valid for 20 minutes (Enrollment code lifetime). Generate a new code in Machines.',
    );
  });

  it('shows a dependency cycle with the ticket numbers', () => {
    const error = new ApiRequestError(409, 'dependency_cycle', 'x', undefined, undefined, [
      'WEB-3',
      'WEB-1',
      'WEB-2',
      'WEB-3',
    ]);
    expect(refusalText(error)).toBe(
      'Refused: this would make a loop in which each ticket waits for the next, so none of them could ever start: WEB-3 → WEB-1 → WEB-2 → WEB-3.',
    );
  });

  it('waits the time the server gives after too many attempts', () => {
    expect(refusalText(new ApiRequestError(429, 'too_many_attempts', 'x', 125))).toBe(
      'Too many failed attempts. Wait 3 minutes before trying again.',
    );
  });
});
