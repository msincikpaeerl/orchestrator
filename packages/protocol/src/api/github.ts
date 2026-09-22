import { z } from 'zod';

/** Repository permissions of a fine-grained token, by their GitHub API name (02, section 3.1). */
export const GitHubPermission = z.enum([
  'administration',
  'contents',
  'pull_requests',
  'workflows',
  'statuses',
  'actions',
  'metadata',
]);
export type GitHubPermission = z.infer<typeof GitHubPermission>;

export const GitHubAccess = z.enum(['read', 'write']);
export type GitHubAccess = z.infer<typeof GitHubAccess>;

export interface RequiredGitHubPermission {
  permission: GitHubPermission;
  access: GitHubAccess;
  /** Name shown by GitHub's token form. */
  label: string;
}

/** The permissions the token needs, in the order of 02, section 3.1. */
export const REQUIRED_GITHUB_PERMISSIONS: readonly RequiredGitHubPermission[] = [
  { permission: 'administration', access: 'write', label: 'Administration' },
  { permission: 'contents', access: 'write', label: 'Contents' },
  { permission: 'pull_requests', access: 'write', label: 'Pull requests' },
  { permission: 'workflows', access: 'write', label: 'Workflows' },
  { permission: 'statuses', access: 'read', label: 'Commit statuses' },
  { permission: 'actions', access: 'read', label: 'Actions' },
  { permission: 'metadata', access: 'read', label: 'Metadata' },
];

/** Expiry pre-filled by the creation link: one year, as the user documentation recommends. */
export const GITHUB_TOKEN_SUGGESTED_LIFETIME_DAYS = 365;

/**
 * GitHub's token form with the name, expiry and permissions filled in (02, section 3.1).
 * It cannot select "All repositories": the owner has to choose it.
 */
export function githubTokenCreationUrl(): string {
  const url = new URL('https://github.com/settings/personal-access-tokens/new');
  url.searchParams.set('name', 'Orchestrator');
  url.searchParams.set(
    'description',
    'Used by the Orchestrator to create repositories, push branches and open pull requests.',
  );
  url.searchParams.set('expires_in', String(GITHUB_TOKEN_SUGGESTED_LIFETIME_DAYS));
  for (const { permission, access } of REQUIRED_GITHUB_PERMISSIONS) {
    url.searchParams.set(permission, access);
  }
  return url.toString();
}

/** A calendar date, `YYYY-MM-DD`: GitHub shows the token's expiry as a date. */
export const CalendarDate = z.iso.date();

/** A pasted token. Never sent back by the server. */
export const GitHubToken = z.string().trim().min(1, 'required').max(1024);

/** `POST /api/github/token/inspect`: checks the token is valid, before the owner saves it. */
export const InspectGitHubTokenRequest = z.object({ token: GitHubToken });
export type InspectGitHubTokenRequest = z.infer<typeof InspectGitHubTokenRequest>;

export const InspectGitHubTokenResponse = z.object({
  /** GitHub login of the token's account. */
  account: z.string(),
  /** From GitHub's expiration header, only when plausible; pre-fills the expiry field. */
  suggestedExpiresOn: CalendarDate.nullable(),
});
export type InspectGitHubTokenResponse = z.infer<typeof InspectGitHubTokenResponse>;

/** `PUT /api/github/token`: saves (or replaces) the token, then checks it. */
export const SaveGitHubTokenRequest = z.object({
  token: GitHubToken,
  /** Entered by the owner; `null` for "No expiry date". */
  expiresOn: CalendarDate.nullable(),
});
export type SaveGitHubTokenRequest = z.infer<typeof SaveGitHubTokenRequest>;

/** Result of one permission in the token check (02, section 3.2). */
export const PermissionCheckResult = z.enum(['ok', 'missing', 'could_not_verify']);
export type PermissionCheckResult = z.infer<typeof PermissionCheckResult>;

export const PermissionCheck = z.object({
  permission: GitHubPermission,
  access: GitHubAccess,
  result: PermissionCheckResult,
  /** Why the result is not `ok`, in English. */
  reason: z.string().optional(),
});
export type PermissionCheck = z.infer<typeof PermissionCheck>;

const Timestamp = z.iso.datetime({ offset: true });

/** Something the owner must fix about the GitHub connection; shown in "Needs you" (02, section 4). */
export const GitHubProblem = z.discriminatedUnion('type', [
  /** GitHub rejected the token (expired, revoked or deleted), whatever its stored expiry date. */
  z.object({ type: z.literal('token_invalid'), since: Timestamp }),
  z.object({ type: z.literal('token_expired'), expiresOn: CalendarDate }),
  z.object({ type: z.literal('token_expiring'), expiresOn: CalendarDate }),
  /** Found by the last token check. */
  z.object({
    type: z.literal('permission_missing'),
    permission: GitHubPermission,
    access: GitHubAccess,
  }),
  /**
   * GitHub refused a request during use. `permissions` comes from GitHub's
   * `X-Accepted-GitHub-Permissions` header (for example `pull_requests=write`); empty when absent.
   */
  z.object({
    type: z.literal('permission_refused'),
    permissions: z.array(z.string()),
    request: z.string(),
    at: Timestamp,
  }),
]);
export type GitHubProblem = z.infer<typeof GitHubProblem>;

/** `GET /api/github`, and the answer to saving and checking the token. Never contains the token. */
export const GitHubStatusResponse = z.discriminatedUnion('connected', [
  z.object({ connected: z.literal(false) }),
  z.object({
    connected: z.literal(true),
    account: z.string(),
    expiresOn: CalendarDate.nullable(),
    savedAt: Timestamp,
    checkedAt: Timestamp,
    permissions: z.array(PermissionCheck),
    problems: z.array(GitHubProblem),
  }),
]);
export type GitHubStatusResponse = z.infer<typeof GitHubStatusResponse>;
