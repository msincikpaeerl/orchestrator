import { ApiErrorCode } from '@orchestrator/protocol';
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
