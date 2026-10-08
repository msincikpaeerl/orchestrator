import { z } from 'zod';
import {
  acceptedPermissions,
  isNotAccessible,
  isRateLimited,
  type GitHubClient,
  type GitHubRequest,
  type GitHubResponse,
} from './client.js';

// GitHub's answers to the requests of lot 3 (pull requests, reviews, CI, branches): a value, or
// the refusal as GitHub gave it, so that each caller decides what it means (a pull request that
// already exists, a review GitHub does not allow on your own pull request, a log not ready yet).
// A missing permission or a rejected token already reaches "Needs you" through the stored-token
// client (`storedTokenClient`, ADR 0022). No answer at all throws `GitHubUnreachableError`.

export type GitHubRefusal =
  /** 401: the token is wrong, expired or revoked. */
  | { kind: 'token_invalid'; status: number; message: string }
  /** 403 "Resource not accessible": `permissions` as GitHub names them (`pull_requests=write`). */
  | { kind: 'permission_missing'; status: number; message: string; permissions: string[] }
  | { kind: 'rate_limited'; status: number; message: string }
  /** 404: the thing does not exist, or the token cannot see it. */
  | { kind: 'not_found'; status: number; message: string }
  /** 422: GitHub cannot do it; `details` are the texts of its `errors` list. */
  | { kind: 'invalid'; status: number; message: string; details: string[] }
  /**
   * The expected status with a body the Orchestrator cannot read: GitHub did what was asked (a
   * 201 created the pull request) but the body does not fit what the Orchestrator reads.
   * `fields` name each field that did not fit, with what came in its place (a type, never a
   * value): `merge_commit_sha: expected string, received nothing`.
   */
  | { kind: 'unreadable'; status: number; message: string; fields: string[] }
  /** Any other answer. */
  | { kind: 'unexpected'; status: number; message: string };

export type GitHubResult<T> = { ok: true; value: T } | { ok: false; refusal: GitHubRefusal };

export const ErrorBody = z.object({
  message: z.string(),
  // Details of a 422, for example "name already exists on this account".
  errors: z.array(z.unknown()).optional(),
});

// A 422's error object carries `resource`, `field` and `code`, and a `message` only for the code
// `custom` ("Client errors", https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api).
const ErrorDetail = z
  .string()
  .or(z.object({ message: z.string() }).transform((e) => e.message))
  .or(
    z
      .object({ field: z.string(), code: z.string() })
      .transform((e) => `${e.field} ${e.code.replace(/_/g, ' ')}`),
  );

/** The texts of a 422's `errors` list: strings, objects with a `message`, else field and code. */
export function errorDetails(body: z.infer<typeof ErrorBody>): string[] {
  return (body.errors ?? []).flatMap((error) => {
    const detail = ErrorDetail.safeParse(error);
    return detail.success ? [detail.data] : [];
  });
}

/** GitHub's message followed by its details: "Validation Failed: A pull request already exists…". */
export function errorText(body: z.infer<typeof ErrorBody>): string {
  return [body.message, ...errorDetails(body)].join(': ');
}

/** The refusal of an answer that is not the one the request expected. */
export function refusalOf(response: GitHubResponse): GitHubRefusal {
  const body = ErrorBody.safeParse(response.body);
  const status = response.status;
  const message = body.success ? errorText(body.data) : `HTTP ${String(status)}`;
  if (status === 401) return { kind: 'token_invalid', status, message };
  if (isRateLimited(response)) return { kind: 'rate_limited', status, message };
  if (isNotAccessible(response)) {
    return {
      kind: 'permission_missing',
      status,
      message,
      permissions: acceptedPermissions(response.headers),
    };
  }
  if (status === 404) return { kind: 'not_found', status, message };
  if (status === 422) {
    return {
      kind: 'invalid',
      status,
      message,
      details: body.success ? errorDetails(body.data) : [],
    };
  }
  return { kind: 'unexpected', status, message };
}

/** What a value is, never what it holds: it could be a secret. */
function kindOf(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') return 'a string';
  if (typeof value === 'number') return 'a number';
  return `a ${typeof value}`;
}

function valueAt(body: unknown, path: PropertyKey[]): unknown {
  let value = body;
  for (const key of path) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  return value;
}

function expectedText(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return issue.expected;
    case 'invalid_value':
      return `one of ${issue.values.map(String).join(', ')}`;
    case 'invalid_union':
      return 'one of the documented forms';
    case 'too_small':
    case 'too_big':
      return `a ${issue.origin} ${issue.code === 'too_small' ? 'above' : 'below'} ${String(issue.code === 'too_small' ? issue.minimum : issue.maximum)}`;
    default:
      return issue.code.replace(/_/g, ' ');
  }
}

/**
 * Each field of `body` that did not fit: its path, what was expected and what came instead, as a
 * type (`created_at: expected string, received null`). Never a value: a body can hold secrets.
 * A value outside an enumeration reads "a string not among them".
 */
export function unfitFields(error: z.ZodError, body: unknown): string[] {
  const fields = error.issues.map((issue) => {
    const path = issue.path.length === 0 ? '(the body)' : issue.path.map(String).join('.');
    const value = valueAt(body, issue.path);
    const received =
      issue.code === 'invalid_value' ? `${kindOf(value)} not among them` : kindOf(value);
    return `${path}: expected ${expectedText(issue)}, received ${received}`;
  });
  return [...new Set(fields)];
}

/** "The answer cannot be read: a: expected …; b: expected …". */
export function unreadableText(fields: string[]): string {
  return `GitHub's answer does not fit what the Orchestrator reads: ${fields.join('; ')}`;
}

/** The value when GitHub answered `expected` with a body the schema reads, else the refusal. */
export function answer<T>(
  response: GitHubResponse,
  expected: number,
  schema: z.ZodType<T>,
): GitHubResult<T> {
  if (response.status !== expected) return { ok: false, refusal: refusalOf(response) };
  const parsed = schema.safeParse(response.body);
  if (!parsed.success) {
    const fields = unfitFields(parsed.error, response.body);
    return {
      ok: false,
      refusal: {
        kind: 'unreadable',
        status: response.status,
        message: unreadableText(fields),
        fields,
      },
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Sends the request and reads GitHub's answer (`answer`). An answer that cannot be read is also
 * logged by the client, with the request and the fields, never a value.
 */
export async function ask<T>(
  client: GitHubClient,
  request: GitHubRequest,
  expected: number,
  schema: z.ZodType<T>,
): Promise<GitHubResult<T>> {
  const result = answer(await client.request(request), expected, schema);
  if (!result.ok && result.refusal.kind === 'unreadable') {
    client.unreadable(request, result.refusal.status, result.refusal.fields);
  }
  return result;
}

export function refused(refusal: GitHubRefusal): { ok: false; refusal: GitHubRefusal } {
  return { ok: false, refusal };
}
