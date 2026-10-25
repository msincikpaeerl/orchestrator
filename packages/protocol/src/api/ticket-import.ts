import { z } from 'zod';
import { boundedText, requiredText, settingCeiling } from '../text-limits.js';
import { AgentKey, AgentLink } from './agents.js';
import { TicketLink, TicketPriority, TicketStatus, TicketType } from './tickets.js';

/*
 * The file of tickets the owner imports on a project's board (02, section 6.3; 06, section 4.6;
 * lot 5bis step A). snake_case like the MCP tools, so plan.propose's tickets (06, section 4.4)
 * reuse `TicketImportEntry`. Strict: an unknown field is refused, never ignored. Texts are capped
 * at the highest value their setting allows (06, section 3); the server checks the current values.
 */

/** The value of the file's `format` field. */
export const TICKET_IMPORT_FORMAT = 'orchestrator-tickets/1';

/**
 * A ticket's local key, unique in its file: lowercase, so it is never mistaken for a ticket
 * number such as `WEB-3` (owner's answer 1, lot 5bis step A).
 */
export const TicketKey = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,39}$/,
    'must be 1 to 40 lowercase letters, digits, "-" or "_", starting with a letter or a digit, such as "contact-form"',
  );
export type TicketKey = z.infer<typeof TicketKey>;

/** One ticket of the file. Optional fields may also be null, which means the same as absent. */
export const TicketImportEntry = z.strictObject({
  key: TicketKey,
  type: TicketType,
  title: requiredText(settingCeiling('ticketTitleMaxLength')),
  description: boundedText(settingCeiling('ticketDescriptionMaxLength')).trim().nullish(),
  acceptance_criteria: z
    .array(requiredText(settingCeiling('acceptanceCriterionMaxLength')))
    .max(settingCeiling('ticketMaxAcceptanceCriteria'))
    .nullish(),
  priority: TicketPriority.nullish(),
  /** Key of an agent profile that can be assigned a ticket. */
  assignee: AgentKey.nullish(),
  /**
   * Keys of tickets of the same file, or numbers of existing tickets of the same project
   * (`WEB-3`); each is told apart by its form, so any other text is refused by the server.
   */
  blocked_by: z.array(z.string().max(64, 'at most 64 characters')).nullish(),
});
export type TicketImportEntry = z.infer<typeof TicketImportEntry>;

/** The whole file. At most **Most tickets per plan** tickets, checked by the server. */
export const TicketImportFile = z.strictObject({
  format: z.literal(TICKET_IMPORT_FORMAT, `must be "${TICKET_IMPORT_FORMAT}"`),
  tickets: z
    .array(TicketImportEntry)
    .min(1, 'the file has no tickets')
    .max(settingCeiling('maxTicketsPerPlan')),
});
export type TicketImportFile = z.infer<typeof TicketImportFile>;

/** The file's text as pasted or read from the .json file; the server parses it. */
export const TicketImportRequest = z.strictObject({ text: z.string() });
export type TicketImportRequest = z.infer<typeof TicketImportRequest>;

/**
 * A problem found in the file, in plain words. `position` (from 1) and `key` locate the ticket,
 * `field` the field (`title`, `acceptance_criteria[2]`); all null for the file as a whole.
 */
export const TicketImportProblem = z.object({
  position: z.int().positive().nullable(),
  key: z.string().nullable(),
  field: z.string().nullable(),
  message: z.string(),
});
export type TicketImportProblem = z.infer<typeof TicketImportProblem>;

/** A dependency as the preview resolves it: another ticket of the file, or an existing one. */
export const TicketImportBlocker = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), key: TicketKey, title: z.string() }),
  z.object({
    kind: z.literal('ticket'),
    number: z.int().positive(),
    title: z.string(),
    status: TicketStatus,
  }),
]);
export type TicketImportBlocker = z.infer<typeof TicketImportBlocker>;

export const TicketImportPreviewTicket = z.object({
  position: z.int().positive(),
  key: TicketKey,
  type: TicketType,
  title: z.string(),
  priority: TicketPriority,
  assignee: AgentLink.nullable(),
  criteria: z.int().min(0),
  blockedBy: z.array(TicketImportBlocker),
});
export type TicketImportPreviewTicket = z.infer<typeof TicketImportPreviewTicket>;

/**
 * What the import would create; nothing is written. `tickets` is empty while the file cannot be
 * read as the format; the import is possible only when `problems` is empty. `warnings` never
 * stop it.
 */
export const TicketImportPreview = z.object({
  tickets: z.array(TicketImportPreviewTicket),
  problems: z.array(TicketImportProblem),
  warnings: z.array(z.string()),
});
export type TicketImportPreview = z.infer<typeof TicketImportPreview>;

/** The tickets created, in the file's order. */
export const TicketImportResponse = z.object({ tickets: z.array(TicketLink) });
export type TicketImportResponse = z.infer<typeof TicketImportResponse>;
