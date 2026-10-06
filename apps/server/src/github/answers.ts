import { z } from 'zod';
import {
  acceptedPermissions,
  isNotAccessible,
  isRateLimited,
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
  /** Any other answer, or a body that is not what GitHub documents. */
  | { kind: 'unexpected'; status: number; message: string };

export type GitHubResult<T> = { ok: true; value: T } | { ok: false; refusal: GitHubRefusal };

export const ErrorBody = z.object({
  message: z.string(),
  // Details of a 422, for example "name already exists on this account".
  errors: z.array(z.unknown()).optional(),
});

const ErrorDetail = z.string().or(z.object({ message: z.string() }).transform((e) => e.message));

/** The texts of a 422's `errors` list: strings, or objects with a `message`. */
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

/** The value when GitHub answered `expected` with the documented body, else the refusal. */
export function answer<T>(
  response: GitHubResponse,
  expected: number,
  schema: z.ZodType<T>,
): GitHubResult<T> {
  if (response.status !== expected) return { ok: false, refusal: refusalOf(response) };
  const parsed = schema.safeParse(response.body);
  if (!parsed.success) {
    return {
      ok: false,
      refusal: {
        kind: 'unexpected',
        status: response.status,
        message: 'The answer is not what GitHub documents',
      },
    };
  }
  return { ok: true, value: parsed.data };
}

export function refused(refusal: GitHubRefusal): { ok: false; refusal: GitHubRefusal } {
  return { ok: false, refusal };
}
