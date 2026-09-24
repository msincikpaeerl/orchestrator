import { z } from 'zod';
import { EventActor, EventEntityType, EventType } from '../events.js';
import { ProjectKey } from './projects.js';

/**
 * Display constants of the event log. They only change how much the screen shows at once, so they
 * are not settings (04, section 8).
 */
export const EVENT_LOG_PAGE_SIZE = 50;
/** Owner or agent content quoted in an event (titles, names, comments) is shortened to this. */
export const EVENT_QUOTE_MAX_LENGTH = 120;

/**
 * Where the next page starts: the time and id of the last event shown. Events are listed newest
 * first, ordered by time then id, so events written meanwhile never shift a page.
 */
export const EventCursor = z.string().regex(/^\d{4}-\d\d-\d\dT[\d:.]+Z_\d+$/, 'invalid cursor');

/**
 * `GET /api/events`: every filter is optional. `ticket` (a number) needs `project`. Events from
 * `from` included to `to` excluded: the screen sends the start of the first day chosen and the
 * start of the day after the last one, in the owner's time zone.
 */
export const EventListQuery = z
  .object({
    project: ProjectKey.optional(),
    ticket: z.coerce.number().int().min(1).optional(),
    entity: EventEntityType.optional(),
    type: EventType.optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    before: EventCursor.optional(),
  })
  .refine((query) => query.ticket === undefined || query.project !== undefined, {
    message: 'ticket needs project',
    path: ['ticket'],
  });
export type EventListQuery = z.infer<typeof EventListQuery>;

/** One event of the log (02, section 7), with what its plain-words text needs. */
export const EventLogEntry = z.object({
  id: z.int(),
  at: z.iso.datetime(),
  actor: EventActor,
  entityType: EventEntityType,
  type: EventType,
  /** The project it concerns, if any, for its link. */
  project: z.object({ key: ProjectKey }).nullable(),
  /** The ticket it concerns, if any, for its link. */
  ticket: z.object({ number: z.int() }).nullable(),
  /**
   * The payload's fields listed in `EventPayloads` for its type, secrets masked; null when it does
   * not match (an event written by a bug), and the log then shows the event type only.
   */
  payload: z.record(z.string(), z.unknown()).nullable(),
  /** The comment of `ticket.commented` or of a **Mark as done manually**, already shortened. */
  comment: z.string().nullable(),
});
export type EventLogEntry = z.infer<typeof EventLogEntry>;

export const EventListResponse = z.object({
  events: z.array(EventLogEntry),
  /** Pass as `before` to get the next, older page; null when there is none. */
  next: EventCursor.nullable(),
});
export type EventListResponse = z.infer<typeof EventListResponse>;

/** Cuts owner or agent content to `max` characters, on one line, ending with "…" when cut. */
export function shorten(text: string, max = EVENT_QUOTE_MAX_LENGTH): string {
  const line = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(line);
  return chars.length <= max
    ? line
    : `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`;
}
