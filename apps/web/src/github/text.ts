import {
  REQUIRED_GITHUB_PERMISSIONS,
  type GitHubAccess,
  type GitHubProblem,
  type PermissionCheckResult,
} from '@orchestrator/protocol';

/** The permission's name in GitHub's token form. */
export function permissionLabel(permission: string): string {
  return (
    REQUIRED_GITHUB_PERMISSIONS.find((required) => required.permission === permission)?.label ??
    permission
  );
}

/** The access level as GitHub's token form names it. */
export function accessLabel(access: GitHubAccess): string {
  return access === 'write' ? 'Read and write' : 'Read-only';
}

export const resultLabel: Record<PermissionCheckResult, string> = {
  ok: 'OK',
  missing: 'Missing',
  could_not_verify: 'Could not verify',
};

/** A date of the form `2027-09-23`, written out: "September 23, 2027". */
export function formatDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
    dateStyle: 'long',
    timeZone: 'UTC',
  });
}

export function formatDateTime(timestamp: string): string {
  return new Date(timestamp).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * `pull_requests=write` from GitHub's X-Accepted-GitHub-Permissions header, written as the token
 * form shows it: "Pull requests (Read and write)".
 */
function acceptedPermissionText(value: string): string {
  const [permission = value, access] = value.split('=');
  return access === 'write' || access === 'read'
    ? `${permissionLabel(permission)} (${accessLabel(access)})`
    : permissionLabel(permission);
}

/** What "Needs you" says about a GitHub problem (02, section 4). */
export function problemText(problem: GitHubProblem): { title: string; detail: string } {
  switch (problem.type) {
    case 'token_unreadable':
      return {
        title: 'Enter your GitHub token again',
        detail:
          'The Orchestrator cannot read the saved token because the secret key in the .env file changed. Enter the token again.',
      };
    case 'token_invalid':
      return {
        title: 'GitHub no longer accepts your token',
        detail:
          'The token was deleted, revoked or has expired on GitHub. Create a new token and enter it.',
      };
    case 'token_expired':
      return {
        title: 'Your GitHub token has expired',
        detail: `It expired on ${formatDate(problem.expiresOn)}. Create a new token and enter it.`,
      };
    case 'token_expiring':
      return {
        title: 'Your GitHub token expires soon',
        detail: `It expires on ${formatDate(problem.expiresOn)}. Create a new token and enter it before then.`,
      };
    case 'permission_missing':
      return {
        title: `The GitHub token is missing the ${permissionLabel(problem.permission)} permission`,
        detail: `Give it "${accessLabel(problem.access)}" access: create a new token with the "Create the token on GitHub" button and enter it.`,
      };
    case 'permission_refused':
      return {
        title: 'GitHub refused a request',
        detail:
          problem.permissions.length > 0
            ? `The token needs: ${problem.permissions.map(acceptedPermissionText).join(', ')}. Create a new token with the "Create the token on GitHub" button and enter it.`
            : 'The token is missing a permission. Create a new token with the "Create the token on GitHub" button and enter it.',
      };
  }
}
