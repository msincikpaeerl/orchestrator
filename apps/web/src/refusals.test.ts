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
