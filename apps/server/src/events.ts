import { schema } from '@orchestrator/db';
import type { EventActor, EventEntityType, EventType } from '@orchestrator/protocol';
import type { Executor } from './database.js';

export interface NewEvent {
  actor: EventActor;
  entityType: EventEntityType;
  entityId?: string;
  type: EventType;
  /** Facts only; never a password, token or other secret. */
  payload?: Record<string, unknown>;
  /** When it happened; the database's clock when absent. */
  at?: Date;
}

/** Writes an event (01, section 3.10), in the caller's transaction when there is one. */
export async function recordEvent(db: Executor, event: NewEvent): Promise<void> {
  await db.insert(schema.events).values({
    actor: event.actor,
    entityType: event.entityType,
    entityId: event.entityId ?? null,
    type: event.type,
    payload: event.payload ?? {},
    ...(event.at ? { createdAt: event.at } : {}),
  });
}
