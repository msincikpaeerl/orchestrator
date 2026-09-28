import { z } from 'zod';
import { EventEntityType } from '../events.js';

/** The realtime stream (02, section 1; 09, section 4): `GET /api/stream`, Server-Sent Events. */
export const STREAM_PATH = '/api/stream';

/**
 * A comment line sent this often keeps proxies from closing a quiet stream. A code constant, not
 * a setting: a transport detail, like the daemon's reconnection backoff (04, section 8).
 */
export const STREAM_KEEP_ALIVE_MS = 20_000;

/** The delay before the browser reconnects a lost stream (the `retry` field; 04, section 8). */
export const STREAM_RETRY_MS = 3_000;

/**
 * One message of the stream, sent as the `data` of an unnamed Server-Sent Event:
 * - `changed`: something of this kind changed (from the event it wrote); `project` is its
 *   project's key when it has one. The screens read again what shows it.
 * - `run_log`: the run has log entries up to `seq`; the screen showing it fetches the entries
 *   after the last one it holds (owner's decision, lot 2 step L).
 * - `resync`: the server may have missed changes (its database listener reconnected): the screens
 *   read everything again, as after a reconnection of the stream.
 */
export const StreamMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('changed'),
    entity: EventEntityType,
    id: z.string().nullable(),
    project: z.string().nullable(),
  }),
  z.object({
    type: z.literal('run_log'),
    run: z.uuid(),
    project: z.string().nullable(),
    seq: z.int().min(0),
  }),
  z.object({ type: z.literal('resync') }),
]);
export type StreamMessage = z.infer<typeof StreamMessage>;
