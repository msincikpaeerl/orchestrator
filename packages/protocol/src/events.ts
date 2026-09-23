import { z } from 'zod';

/** Who caused an event (01, section 3.10). `cli` is a command run in the server container. */
export const EventActor = z.enum(['owner', 'system', 'cli']);
export type EventActor = z.infer<typeof EventActor>;

export const EventEntityType = z.enum([
  'owner',
  'session',
  'github_connection',
  'project',
  'ticket',
  'setting',
]);
export type EventEntityType = z.infer<typeof EventEntityType>;

/** Event types written so far; each lot adds its own. Payloads never contain secrets. */
export const EventType = z.enum([
  'owner.created',
  'owner.login_throttled',
  'owner.password_reset',
  'session.created',
  'session.revoked',
  'github.token_saved',
  'github.token_checked',
  'github.token_rejected',
  'github.token_unreadable',
  'github.permission_refused',
  'project.created',
  'project.updated',
  'project.setup_step',
  'project.setup_failed',
  'project.setup_retried',
  'project.ready',
  'project.harness_checked',
  'project.archived',
  'project.unarchived',
  'ticket.created',
  'ticket.updated',
  'ticket.status_changed',
  'ticket.dependency_added',
  'ticket.dependency_removed',
  'ticket.commented',
  'setting.changed',
  'setting.reset',
]);
export type EventType = z.infer<typeof EventType>;
