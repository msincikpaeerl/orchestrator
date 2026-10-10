import { z } from 'zod';

/** GitHub's REST API; tests point the server at a local fake instead. */
export const GITHUB_API_URL = 'https://api.github.com';
/** Where repositories are cloned from: `https://github.com/<owner>/<name>.git`. */
export const GITHUB_WEB_URL = 'https://github.com';
const API_VERSION = '2026-03-10';

/**
 * GitHub could not be reached, timed out or answered with a server error. `sent` (true unless
 * said) is false only when the request surely never reached GitHub (no connection could be made),
 * so that a post's answer lost after it left is told apart (lot 3 step H3).
 */
export class GitHubUnreachableError extends Error {
  override name = 'GitHubUnreachableError';

  constructor(message: string, options: { cause?: unknown; sent?: boolean } = {}) {
    super(message, { cause: options.cause });
    this.sent = options.sent ?? true;
  }

  readonly sent: boolean;
}

/** The connection errors that leave a request unsent: nothing reached GitHub. */
const NOT_SENT = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED',
]);

/**
 * Whether a request fetch failed for may have reached GitHub: anything but a connection never
 * made (a timeout or a connection cut may come after GitHub received it).
 */
export function mayHaveArrived(error: unknown): boolean {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
  return !(typeof code === 'string' && NOT_SENT.has(code));
}

export interface GitHubResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON, or null when the body is empty or not JSON. */
  body: unknown;
  /** The request answered, when the client sent it (for logs). */
  request?: GitHubRequest;
}

export interface GitHubRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path and query, for example `/user/repos?per_page=1`. */
  path: string;
  body?: unknown;
}

/**
 * A file GitHub serves through a redirect: how its reading ended (`end` of the file, `enough` when
 * the reader needed no more, `ceiling` when `maxBytes` came first) and the bytes read; or GitHub's
 * answer when there is no file.
 */
export type GitHubDownload =
  | { ok: true; ended: 'end' | 'enough' | 'ceiling'; bytes: number }
  | { ok: false; response: GitHubResponse };

export interface GitHubClient {
  /** Never throws for an HTTP status; throws `GitHubUnreachableError` when no answer comes. */
  request(request: GitHubRequest): Promise<GitHubResponse>;
  /**
   * A `GET` GitHub answers with a redirect to a file on another host (a job's log): the file is
   * downloaded without the API's Authorization header and given to `read` as it comes, at most
   * `maxBytes` bytes; `read` returns false when it needs no more. Throws `GitHubUnreachableError`
   * like `request`.
   */
  download(
    path: string,
    read: (chunk: Uint8Array) => boolean,
    maxBytes: number,
  ): Promise<GitHubDownload>;
  /**
   * Logs an answer the Orchestrator could not read (`answers.ts`): the request, GitHub's status
   * and the fields that did not fit, never the body.
   */
  unreadable(request: GitHubRequest, status: number, fields: string[]): void;
}

/** Where the client logs (the server's Pino logger). */
export interface GitHubLog {
  warn(object: object, message: string): void;
}

export interface GitHubClientOptions {
  apiUrl: string;
  /** Sent in the Authorization header only; never logged or included in errors. */
  token: string;
  timeoutSeconds: number;
  /** Called with every answer, for example to record refusals (ADR 0022). */
  onResponse?: (request: GitHubRequest, response: GitHubResponse) => Promise<void>;
  /** Where answers the Orchestrator cannot read are logged; nowhere when not given. */
  log?: GitHubLog;
}

/** `GET /repos/o/r/pulls`: the method and the path, without the query. */
export function describeRequest(request: GitHubRequest): string {
  return `${request.method} ${request.path.split('?')[0] ?? request.path}`;
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const headers = (body: boolean) => ({
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${options.token}`,
    'user-agent': 'orchestrator',
    'x-github-api-version': API_VERSION,
    ...(body ? { 'content-type': 'application/json' } : {}),
  });

  async function send(request: GitHubRequest, redirect: 'follow' | 'manual'): Promise<Response> {
    try {
      return await fetch(new URL(request.path, options.apiUrl), {
        method: request.method,
        headers: headers(request.body !== undefined),
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        redirect,
        signal: AbortSignal.timeout(options.timeoutSeconds * 1000),
      });
    } catch (error) {
      // The cause is a network or timeout error from fetch; it never contains the headers.
      throw new GitHubUnreachableError(`${request.method} ${request.path}: no answer from GitHub`, {
        cause: error,
        sent: mayHaveArrived(error),
      });
    }
  }

  async function finish(request: GitHubRequest, response: Response): Promise<GitHubResponse> {
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      // The answer began but was cut: GitHub received the request.
      throw new GitHubUnreachableError(
        `${request.method} ${request.path}: GitHub's answer was cut`,
        { cause: error, sent: true },
      );
    }
    let body: unknown;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      body = null;
    }
    const result = { status: response.status, headers: response.headers, body, request };
    if (response.status >= 500) {
      throw new GitHubUnreachableError(
        `${request.method} ${request.path}: GitHub answered HTTP ${String(response.status)}`,
        { sent: true },
      );
    }
    await options.onResponse?.(request, result);
    return result;
  }

  return {
    async request(request) {
      return finish(request, await send(request, 'follow'));
    },

    unreadable(request, status, fields) {
      options.log?.warn(
        { request: describeRequest(request), status, fields },
        "GitHub's answer does not fit what the Orchestrator reads",
      );
    },

    async download(path, read, maxBytes) {
      const request: GitHubRequest = { method: 'GET', path };
      const redirect = await send(request, 'manual');
      const location = redirect.headers.get('location');
      if (redirect.status !== 302 || location === null) {
        return { ok: false, response: await finish(request, redirect) };
      }
      await redirect.body?.cancel();
      let file: Response;
      try {
        // A signed link to another host: no Authorization, never the token (lot 3 plan, A13).
        file = await fetch(location, {
          headers: { 'user-agent': 'orchestrator' },
          signal: AbortSignal.timeout(options.timeoutSeconds * 1000),
        });
      } catch (error) {
        throw new GitHubUnreachableError(`GET ${path}: the file GitHub links to did not come`, {
          cause: error,
        });
      }
      if (file.status !== 200) {
        const message = (await file.text()).slice(0, 200);
        if (file.status >= 500) {
          throw new GitHubUnreachableError(
            `GET ${path}: the file GitHub links to answered HTTP ${String(file.status)}`,
          );
        }
        return {
          ok: false,
          response: { status: file.status, headers: file.headers, body: { message } },
        };
      }
      return { ok: true, ...(await stream(file, read, maxBytes)) };
    },
  };
}

/** Gives the body to `read` as it comes, at most `maxBytes` bytes. */
async function stream(
  response: Response,
  read: (chunk: Uint8Array) => boolean,
  maxBytes: number,
): Promise<{ ended: 'end' | 'enough' | 'ceiling'; bytes: number }> {
  // A fetch body gives bytes.
  const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
  let bytes = 0;
  if (!reader) return { ended: 'end', bytes };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { ended: 'end', bytes };
    if (bytes + value.length > maxBytes) {
      const kept = value.subarray(0, maxBytes - bytes);
      bytes += kept.length;
      read(kept);
      await reader.cancel();
      return { ended: 'ceiling', bytes };
    }
    bytes += value.length;
    if (!read(value)) {
      await reader.cancel();
      return { ended: 'enough', bytes };
    }
  }
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
