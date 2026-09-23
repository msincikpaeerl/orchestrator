import { z } from 'zod';

/** GitHub's REST API; tests point the server at a local fake instead. */
export const GITHUB_API_URL = 'https://api.github.com';
const API_VERSION = '2026-03-10';

/** GitHub could not be reached, timed out or answered with a server error. */
export class GitHubUnreachableError extends Error {
  override name = 'GitHubUnreachableError';
}

export interface GitHubResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON, or null when the body is empty or not JSON. */
  body: unknown;
}

export interface GitHubRequest {
  method: 'GET' | 'POST' | 'PUT';
  /** Path and query, for example `/user/repos?per_page=1`. */
  path: string;
  body?: unknown;
}

export interface GitHubClient {
  /** Never throws for an HTTP status; throws `GitHubUnreachableError` when no answer comes. */
  request(request: GitHubRequest): Promise<GitHubResponse>;
}

export interface GitHubClientOptions {
  apiUrl: string;
  /** Sent in the Authorization header only; never logged or included in errors. */
  token: string;
  timeoutSeconds: number;
  /** Called with every answer, for example to record refusals (ADR 0017). */
  onResponse?: (request: GitHubRequest, response: GitHubResponse) => Promise<void>;
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  return {
    async request(request) {
      let response: Response;
      try {
        response = await fetch(new URL(request.path, options.apiUrl), {
          method: request.method,
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${options.token}`,
            'user-agent': 'orchestrator',
            'x-github-api-version': API_VERSION,
            ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          signal: AbortSignal.timeout(options.timeoutSeconds * 1000),
        });
      } catch (error) {
        // The cause is a network or timeout error from fetch; it never contains the headers.
        throw new GitHubUnreachableError(
          `${request.method} ${request.path}: no answer from GitHub`,
          {
            cause: error,
          },
        );
      }
      const text = await response.text();
      let body: unknown;
      try {
        body = text === '' ? null : JSON.parse(text);
      } catch {
        body = null;
      }
      const result = { status: response.status, headers: response.headers, body };
      if (response.status >= 500) {
        throw new GitHubUnreachableError(
          `${request.method} ${request.path}: GitHub answered HTTP ${String(response.status)}`,
        );
      }
      await options.onResponse?.(request, result);
      return result;
    },
  };
}

/**
 * Permissions named by GitHub's `X-Accepted-GitHub-Permissions` header, as `name=access`
 * (for example `pull_requests=write`). Empty when the header is absent.
 */
export function acceptedPermissions(headers: Headers): string[] {
  const value = headers.get('x-accepted-github-permissions');
  if (value === null) return [];
  return value
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter((part) => /^[a-z_]+=[a-z]+$/.test(part));
}

const ErrorBody = z.object({ message: z.string() });

/** GitHub's answer when the token lacks the permission: "Resource not accessible by personal access token". */
export function isNotAccessible(response: GitHubResponse): boolean {
  const parsed = ErrorBody.safeParse(response.body);
  return (
    response.status === 403 &&
    parsed.success &&
    parsed.data.message.startsWith('Resource not accessible')
  );
}

export function isRateLimited(response: GitHubResponse): boolean {
  return (
    (response.status === 403 || response.status === 429) &&
    (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'))
  );
}
