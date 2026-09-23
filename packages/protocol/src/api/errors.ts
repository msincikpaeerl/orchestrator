import { z } from 'zod';

/** Machine-readable reason of an API refusal; the UI chooses its message from it. */
export const ApiErrorCode = z.enum([
  'invalid_request',
  /** No route at this address. */
  'not_found',
  'not_authenticated',
  'owner_exists',
  'invalid_credentials',
  /** Too many failed logins: wait `retryAfterSeconds` (also in the Retry-After header). */
  'too_many_attempts',
  'github_not_connected',
  'github_token_invalid',
  'github_token_not_fine_grained',
  /** The stored token cannot be decrypted: ORCHESTRATOR_SECRET_KEY changed since it was saved. */
  'github_token_unreadable',
  'github_unreachable',
  'expiry_date_in_past',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

/** Body of every 4xx and 5xx answer of the API. The message is English, for logs and developers. */
export const ApiError = z.object({
  error: z.object({
    code: ApiErrorCode,
    message: z.string(),
    retryAfterSeconds: z.int().positive().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
