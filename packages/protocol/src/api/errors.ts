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
  /** GitHub answered a request, but refused it or not as expected; the message says why. */
  'github_request_failed',
  'project_not_found',
  'project_key_taken',
  /** A repository with this name exists on the owner's GitHub account. */
  'repository_name_taken',
  'repository_not_found',
  'repository_archived',
  'repository_already_linked',
  /** Archived projects are read-only: unarchive first. */
  'project_archived',
  'project_not_archived',
  'project_setup_in_progress',
  'project_setup_not_failed',
  /** Check again is for linked repositories whose setup is done. */
  'project_not_linked',
  'project_not_ready',
  /** No ticket with this number in the project. */
  'ticket_not_found',
  /** Tickets can be edited only in `proposed` and `todo`. */
  'ticket_not_editable',
  /** The action is not possible from the ticket's status (04, section 2); the message says why. */
  'ticket_transition_not_allowed',
  'dependency_on_itself',
  /** The dependency would close a cycle; the message names it (`WEB-1 → WEB-2 → WEB-1`). */
  'dependency_cycle',
  'dependency_not_found',
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
