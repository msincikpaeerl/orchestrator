import { z } from 'zod';
import { requiredText } from '../text-limits.js';

/**
 * Identifier of a message between the server and a daemon (05, section 3.3). An answer (`ack`,
 * `welcome`, `mcp.result`, `git.credential`) carries the id of the message it answers.
 */
export const MessageId = z.uuid();
export type MessageId = z.infer<typeof MessageId>;

/** A message of type `type`: `{ type, id, payload }` (05, section 3.3). */
export function message<Type extends string, Payload extends z.ZodType>(
  type: Type,
  payload: Payload,
) {
  return z.object({ type: z.literal(type), id: MessageId, payload });
}

/**
 * `ack`, sent both ways with the id of the message it acknowledges (05, section 3.3): the server's
 * commands (`run.start`, `run.input`, `run.resume`, `run.stop`) and the daemon's reports
 * (`run.state`, one per `run.events` batch, `run.quota_limited`). A duplicate is acknowledged
 * again and changes nothing. `ok: false` says why the message could not be handled.
 */
export const Ack = message(
  'ack',
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true) }),
    z.object({ ok: z.literal(false), message: requiredText() }),
  ]),
);
export type Ack = z.infer<typeof Ack>;
