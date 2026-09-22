import {
  REQUIRED_GITHUB_PERMISSIONS,
  type GitHubPermission,
  type PermissionCheck,
  type PermissionCheckResult,
} from '@orchestrator/protocol';
import { z } from 'zod';
import {
  acceptedPermissions,
  isNotAccessible,
  isRateLimited,
  type GitHubClient,
  type GitHubRequest,
  type GitHubResponse,
  GitHubUnreachableError,
} from './client.js';

// The token check of 02, section 3.2 and ADR 0017. It never creates or changes anything on
// GitHub: write permissions are probed with requests GitHub must refuse as invalid.

export type TokenIdentity =
  { valid: false } | { valid: true; account: string; suggestedExpiresOn: string | null };

export type TokenCheck =
  { valid: false } | { valid: true; account: string; permissions: PermissionCheck[] };

const User = z.object({ login: z.string().min(1) });

const Repository = z.object({
  name: z.string(),
  owner: z.object({ login: z.string() }),
  private: z.boolean(),
  archived: z.boolean(),
  default_branch: z.string(),
});
type Repository = z.infer<typeof Repository>;

/** Fine-grained tokens start with `github_pat_`; classic tokens (`ghp_`) are refused. */
export function isFineGrainedToken(token: string): boolean {
  return token.startsWith('github_pat_');
}

/** Checks the token is valid and reads its account name and, when plausible, its expiry date. */
export async function inspectToken(client: GitHubClient, now = new Date()): Promise<TokenIdentity> {
  const response = await client.request({ method: 'GET', path: '/user' });
  if (response.status === 401) return { valid: false };
  const user = User.safeParse(response.body);
  if (response.status !== 200 || !user.success) {
    throw new GitHubUnreachableError(
      `GET /user: unexpected answer HTTP ${String(response.status)}`,
    );
  }
  return {
    valid: true,
    account: user.data.login,
    suggestedExpiresOn: plausibleExpiry(
      response.headers.get('github-authentication-token-expiration'),
      now,
    ),
  };
}

const MAX_TOKEN_LIFETIME_DAYS = 366;

/**
 * The date of GitHub's `GitHub-Authentication-Token-Expiration` header (for example
 * `2027-09-23 10:00:00 +0200` or `... UTC`), only when it is in the future and at most 366 days
 * ahead: the header has been seen returning the request time (ADR 0017).
 */
export function plausibleExpiry(header: string | null, now: Date): string | null {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|[+-]\d{2}:?\d{2})$/.exec(
    header?.trim() ?? '',
  );
  if (!match) return null;
  const [, day, time, zone] = match as unknown as [string, string, string, string];
  const offset = zone === 'UTC' ? 'Z' : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  const expiresAt = new Date(`${day}T${time}${offset}`);
  if (Number.isNaN(expiresAt.getTime())) return null;
  const ahead = expiresAt.getTime() - now.getTime();
  const plausible =
    ahead > 60 * 60 * 1000 && ahead <= MAX_TOKEN_LIFETIME_DAYS * 24 * 60 * 60 * 1000;
  return plausible ? day : null;
}

interface Outcome {
  result: PermissionCheckResult;
  reason?: string;
}

const ok: Outcome = { result: 'ok' };
const unverified = (reason: string): Outcome => ({ result: 'could_not_verify', reason });

/** Validity, then each permission of 02, section 3.1 as OK, Missing or Could not verify. */
export async function checkToken(client: GitHubClient, now = new Date()): Promise<TokenCheck> {
  const identity = await inspectToken(client, now);
  if (!identity.valid) return { valid: false };

  const outcomes = new Map<GitHubPermission, Outcome>();
  const repositories = await listOwnedRepositories(client);

  // Read probes need a private repository: any token can read public ones.
  const readRepo = pick(repositories, (repo) => repo.private, 'No private repository to test on');
  if (typeof readRepo === 'string') {
    for (const permission of ['metadata', 'actions', 'statuses'] as const) {
      outcomes.set(permission, unverified(readRepo));
    }
  } else {
    outcomes.set('metadata', ok);
    const base = repoPath(readRepo);
    outcomes.set(
      'actions',
      await probe(client, 'actions', 'read', {
        method: 'GET',
        path: `${base}/actions/runs?per_page=1`,
      }),
    );
    outcomes.set(
      'statuses',
      await probe(client, 'statuses', 'read', {
        method: 'GET',
        path: `${base}/commits/${encodeURIComponent(readRepo.default_branch)}/status`,
      }),
    );
  }

  // An empty name is invalid: GitHub cannot create a repository from this request.
  outcomes.set(
    'administration',
    await probe(client, 'administration', 'write', {
      method: 'POST',
      path: '/user/repos',
      body: { name: '' },
    }),
  );

  // Write probes: a private repository when there is one, otherwise a public one.
  const writeRepo = pick(
    repositories,
    (repo) => !repo.archived,
    'No repository to test on that is not archived',
  );
  if (typeof writeRepo === 'string') {
    for (const permission of ['contents', 'pull_requests', 'workflows'] as const) {
      outcomes.set(permission, unverified(writeRepo));
    }
  } else {
    const base = repoPath(writeRepo);
    // Without `message` and `content`, GitHub cannot write the file.
    outcomes.set(
      'contents',
      await probe(client, 'contents', 'write', {
        method: 'PUT',
        path: `${base}/contents/.orchestrator-token-check`,
        body: {},
      }),
    );
    // Without `head` and `base`, GitHub cannot open a pull request.
    outcomes.set(
      'pull_requests',
      await probe(client, 'pull_requests', 'write', {
        method: 'POST',
        path: `${base}/pulls`,
        body: {},
      }),
    );
    outcomes.set(
      'workflows',
      await probe(
        client,
        'workflows',
        'write',
        {
          method: 'PUT',
          path: `${base}/contents/.github/workflows/orchestrator-token-check.yml`,
          body: {},
        },
        outcomes.get('contents')?.result === 'ok',
      ),
    );
  }

  return {
    valid: true,
    account: identity.account,
    permissions: REQUIRED_GITHUB_PERMISSIONS.map(({ permission, access }) => ({
      permission,
      access,
      ...(outcomes.get(permission) ?? unverified('not checked')),
    })),
  };
}

type RepositoryList = Repository[] | { unavailable: string };

async function listOwnedRepositories(client: GitHubClient): Promise<RepositoryList> {
  try {
    const response = await client.request({
      method: 'GET',
      path: '/user/repos?affiliation=owner&sort=pushed&per_page=100',
    });
    const repositories = z.array(Repository).safeParse(response.body);
    if (response.status !== 200 || !repositories.success) {
      return {
        unavailable: `GitHub did not list the repositories (HTTP ${String(response.status)})`,
      };
    }
    return repositories.data;
  } catch (error) {
    if (error instanceof GitHubUnreachableError)
      return { unavailable: 'GitHub could not be reached' };
    throw error;
  }
}

/** A repository matching `wanted`, preferring private then non-archived; or why there is none. */
function pick(
  list: RepositoryList,
  wanted: (repo: Repository) => boolean,
  noneReason: string,
): Repository | string {
  if (!Array.isArray(list)) return list.unavailable;
  const rank = (repo: Repository) => (repo.private ? 0 : 2) + (repo.archived ? 1 : 0);
  return list.filter(wanted).sort((a, b) => rank(a) - rank(b))[0] ?? noneReason;
}

function repoPath(repo: Repository): string {
  return `/repos/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}`;
}

/**
 * Sends one probe and classifies GitHub's answer. `prerequisiteOk` is false when a refusal could
 * come from another permission (Workflows needs Contents): only the header can then say Missing.
 */
async function probe(
  client: GitHubClient,
  permission: GitHubPermission,
  access: 'read' | 'write',
  request: GitHubRequest,
  prerequisiteOk = true,
): Promise<Outcome> {
  let response: GitHubResponse;
  try {
    response = await client.request(request);
  } catch (error) {
    if (error instanceof GitHubUnreachableError) return unverified('GitHub could not be reached');
    throw error;
  }
  return classify(response, permission, access, prerequisiteOk);
}

export function classify(
  response: GitHubResponse,
  permission: GitHubPermission,
  access: 'read' | 'write',
  prerequisiteOk = true,
): Outcome {
  // A read that succeeds, or a write refused only because the request is invalid.
  if (access === 'read' ? response.status === 200 : response.status === 422) return ok;
  if (isRateLimited(response)) return unverified('GitHub rate limit reached; try again later');
  const accepted = acceptedPermissions(response.headers);
  if (response.status === 403 && accepted.length > 0) {
    return accepted.some((entry) => entry.startsWith(`${permission}=`))
      ? { result: 'missing' }
      : unverified(`GitHub asked for other permissions: ${accepted.join(', ')}`);
  }
  if (isNotAccessible(response)) {
    return prerequisiteOk
      ? { result: 'missing' }
      : unverified('Contents must be OK before Workflows can be checked');
  }
  return unverified(`Unexpected answer from GitHub (HTTP ${String(response.status)})`);
}
