import { ApiError, type ApiErrorCode } from '@orchestrator/protocol';

/** A refusal of the API, with the code the UI chooses its message from. */
export class ApiRequestError extends Error {
  override name = 'ApiRequestError';
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | 'unexpected',
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/** Called when the API answers 401: the session ended, the UI goes back to the login page. */
let onUnauthenticated: () => void = () => undefined;
export function setUnauthenticatedHandler(handler: () => void) {
  onUnauthenticated = handler;
}

/**
 * Calls the API and validates the answer with its protocol schema. `schema` is omitted for
 * answers without a body.
 */
export async function api<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  path: string,
  schema: { parse(value: unknown): T } | null,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiRequestError(0, 'unexpected', 'The Orchestrator could not be reached');
  }
  if (!response.ok) {
    const parsed = ApiError.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new ApiRequestError(response.status, 'unexpected', `Error ${String(response.status)}`);
    }
    const { code, message, retryAfterSeconds } = parsed.data.error;
    if (code === 'not_authenticated') onUnauthenticated();
    throw new ApiRequestError(response.status, code, message, retryAfterSeconds);
  }
  if (schema === null) return undefined as T;
  return schema.parse(await response.json());
}
