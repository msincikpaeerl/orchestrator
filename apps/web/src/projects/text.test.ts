import type { ApiErrorCode } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../api';
import { refusalText, suggestKey } from './text';

describe('suggestKey', () => {
  it('takes the initials of several words', () => {
    expect(suggestKey('My web shop')).toBe('MWS');
    expect(suggestKey('Café des Arts')).toBe('CDA');
    expect(suggestKey('one two three four five six seven')).toBe('OTTFFS');
  });

  it('takes the first four letters of one word', () => {
    expect(suggestKey('Recipes')).toBe('RECI');
    expect(suggestKey('Go')).toBe('GO');
  });

  it('suggests nothing without enough letters', () => {
    expect(suggestKey('')).toBe('');
    expect(suggestKey('A')).toBe('');
    expect(suggestKey('2048')).toBe('');
  });
});

describe('refusalText', () => {
  it('puts each refusal next to its field', () => {
    const field = (code: ApiErrorCode) => refusalText(new ApiRequestError(409, code, 'x')).field;
    expect(field('project_key_taken')).toBe('key');
    expect(field('repository_name_taken')).toBe('repository');
    expect(field('repository_already_linked')).toBe('repository');
    expect(field('repository_archived')).toBe('repository');
    expect(field('github_request_failed')).toBe('form');
  });

  it('keeps GitHub’s reason, written for the owner', () => {
    const error = new ApiRequestError(
      502,
      'github_request_failed',
      'Could not create the repository: GitHub answered HTTP 422 (Validation Failed)',
    );
    expect(refusalText(error).text).toBe(
      'GitHub refused the request. Could not create the repository: GitHub answered HTTP 422 (Validation Failed).',
    );
  });
});
