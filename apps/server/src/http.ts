import type { ApiError, ApiErrorCode } from '@orchestrator/protocol';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

/** A refusal sent to the client as `ApiError`. The message never contains submitted values. */
export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
    /** Details the UI uses to explain the refusal (`limits`, `cycle`). */
    readonly details: Pick<ApiError['error'], 'limits' | 'cycle'> = {},
  ) {
    super(message);
  }
}

/** Validates a request body with its protocol schema; explains the problems without the values. */
export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`,
    );
    throw new HttpError(400, 'invalid_request', problems.join('; '));
  }
  return result.data;
}

/**
 * Error handler of the application. Fastify's own client errors (malformed JSON, wrong content
 * type, body too large) get a fixed message: parser messages can quote the body, which may
 * contain a password or token.
 */
export function handleError(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof HttpError) {
    return reply.code(error.statusCode).send({
      error: { code: error.code, message: error.message, ...error.details },
    } satisfies ApiError);
  }
  const status = error.statusCode ?? 500;
  if (status < 500) {
    request.log.info({ code: error.code, status }, 'request refused');
    return reply.code(status).send({
      error: { code: 'invalid_request', message: `Invalid request (${error.code})` },
    } satisfies ApiError);
  }
  request.log.error({ err: error }, 'request failed');
  return reply.code(500).send({ error: { code: 'invalid_request', message: 'Internal error' } });
}
