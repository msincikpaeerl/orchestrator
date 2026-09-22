import { describe, expect, it } from 'vitest';
import type { GitHubResponse } from './client.js';
import { classify, isFineGrainedToken, plausibleExpiry } from './token-check.js';

const now = new Date('2026-09-23T12:00:00Z');

describe('plausibleExpiry', () => {
  it.each([
    ['2027-03-01 08:30:00 UTC', '2027-03-01'],
    ['2027-03-01 08:30:00 +0200', '2027-03-01'],
    ['2027-09-24 00:00:00 -05:00', '2027-09-24'],
  ])('keeps the date of %s', (header, date) => {
    expect(plausibleExpiry(header, now)).toBe(date);
  });

  it.each([
    ['absent', null],
    ['the request time', '2026-09-23 12:00:00 UTC'],
    ['a past date', '2026-01-01 00:00:00 UTC'],
    ['more than 366 days ahead', '2027-09-25 12:00:00 UTC'],
    ['an unknown format', 'Wed, 01 Mar 2027 08:30:00 GMT'],
  ])('ignores a header that is %s', (_case, header) => {
    expect(plausibleExpiry(header, now)).toBeNull();
  });
});

function response(status: number, body: unknown = null, headers: Record<string, string> = {}) {
  return { status, body, headers: new Headers(headers) } satisfies GitHubResponse;
}

const notAccessible = { message: 'Resource not accessible by personal access token' };

describe('classify', () => {
  it('reads OK on 200 and writes OK on 422 only', () => {
    expect(classify(response(200), 'actions', 'read').result).toBe('ok');
    expect(classify(response(422), 'contents', 'write').result).toBe('ok');
    expect(classify(response(201), 'contents', 'write')).toEqual({
      result: 'could_not_verify',
      reason: 'Unexpected answer from GitHub (HTTP 201)',
    });
  });

  it('says Missing when GitHub names the permission or says "not accessible"', () => {
    const named = response(
      403,
      { message: 'Forbidden' },
      {
        'x-accepted-github-permissions': 'contents=write; workflows=write',
      },
    );
    expect(classify(named, 'workflows', 'write').result).toBe('missing');
    expect(classify(response(403, notAccessible), 'actions', 'read').result).toBe('missing');
  });

  it('never guesses from other refusals', () => {
    const other = response(403, notAccessible, { 'x-accepted-github-permissions': 'issues=read' });
    expect(classify(other, 'actions', 'read')).toEqual({
      result: 'could_not_verify',
      reason: 'GitHub asked for other permissions: issues=read',
    });
    const limited = response(
      403,
      { message: 'API rate limit exceeded' },
      {
        'x-ratelimit-remaining': '0',
      },
    );
    expect(classify(limited, 'actions', 'read').result).toBe('could_not_verify');
    expect(classify(response(404, { message: 'Not Found' }), 'actions', 'read').result).toBe(
      'could_not_verify',
    );
    expect(
      classify(response(403, { message: 'Repository was archived' }), 'contents', 'write').result,
    ).toBe('could_not_verify');
  });
});

it('recognises fine-grained tokens by their prefix', () => {
  expect(isFineGrainedToken('github_pat_11ABC')).toBe(true);
  expect(isFineGrainedToken('ghp_abc')).toBe(false);
});
