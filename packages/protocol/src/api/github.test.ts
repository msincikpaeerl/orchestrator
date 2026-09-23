import { describe, expect, it } from 'vitest';
import { GitHubStatusResponse, SaveGitHubTokenRequest, githubTokenCreationUrl } from './github.js';

describe('githubTokenCreationUrl', () => {
  it("opens GitHub's fine-grained token form with every required permission and one year", () => {
    const url = new URL(githubTokenCreationUrl());
    expect(url.origin + url.pathname).toBe(
      'https://github.com/settings/personal-access-tokens/new',
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      name: 'Orchestrator',
      expires_in: '365',
      administration: 'write',
      contents: 'write',
      pull_requests: 'write',
      workflows: 'write',
      statuses: 'read',
      actions: 'read',
      metadata: 'read',
    });
    expect(url.searchParams.has('checks')).toBe(false);
  });
});

describe('SaveGitHubTokenRequest', () => {
  it('takes an expiry date or null for "No expiry date"', () => {
    expect(SaveGitHubTokenRequest.safeParse({ token: 'x', expiresOn: '2027-09-23' }).success).toBe(
      true,
    );
    expect(SaveGitHubTokenRequest.safeParse({ token: 'x', expiresOn: null }).success).toBe(true);
    expect(SaveGitHubTokenRequest.safeParse({ token: 'x', expiresOn: '23/09/2027' }).success).toBe(
      false,
    );
    expect(SaveGitHubTokenRequest.safeParse({ token: 'x' }).success).toBe(false);
  });
});

describe('GitHubStatusResponse', () => {
  it('describes a connected token without the token itself', () => {
    const status = GitHubStatusResponse.parse({
      connected: true,
      account: 'octocat',
      expiresOn: null,
      savedAt: '2026-09-23T10:00:00.000Z',
      checkedAt: '2026-09-23T10:00:00.000Z',
      permissions: [{ permission: 'contents', access: 'write', result: 'ok' }],
      problems: [{ type: 'permission_missing', permission: 'workflows', access: 'write' }],
      token: 'github_pat_secret',
    });
    expect(status).not.toHaveProperty('token');
  });
});
