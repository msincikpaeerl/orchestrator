import { ApiError, type ApiErrorCode, type LimitExceeded } from '@orchestrator/protocol';

/** A refusal of the API, with the code the UI chooses its message from. */
export class ApiRequestError extends Error {
  override name = 'ApiRequestError';
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | 'unexpected',
    message: string,
    readonly retryAfterSeconds?: number,
    /** Fields over their limit, for `invalid_request`. */
    readonly limits?: LimitExceeded[],
    /** Tickets of the cycle, for `dependency_cycle`. */
    readonly cycle?: string[],
    /** The two settings out of order, for `setting_order_invalid`. */
    readonly settingOrder?: ApiError['error']['settingOrder'],
    /** The setting behind the refusal and its current value. */
    readonly setting?: ApiError['error']['setting'],
    /** The two settings whose product is too large, for `setting_product_invalid`. */
    readonly settingProduct?: ApiError['error']['settingProduct'],
    /** Why **Run now** or **Resume** cannot start, for `run_not_possible`. */
    readonly runRefusal?: ApiError['error']['runRefusal'],
    /** The three settings of a sum too large, for `setting_sum_invalid`. */
    readonly settingSum?: ApiError['error']['settingSum'],
    /** Why **Check CI again** was refused, with its facts, for `ci_check_refused`. */
    readonly ciRefusal?: ApiError['error']['ciRefusal'],
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
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
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
    const {
      code,
      message,
      retryAfterSeconds,
      limits,
      cycle,
      settingOrder,
      setting,
      settingProduct,
      runRefusal,
      settingSum,
      ciRefusal,
    } = parsed.data.error;
    if (code === 'not_authenticated') onUnauthenticated();
    throw new ApiRequestError(
      response.status,
      code,
      message,
      retryAfterSeconds,
      limits,
      cycle,
      settingOrder,
      setting,
      settingProduct,
      runRefusal,
      settingSum,
      ciRefusal,
    );
  }
  if (schema === null) return undefined as T;
  return schema.parse(await response.json());
}
