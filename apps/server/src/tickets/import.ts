import {
  SETTINGS,
  TicketImportEntry,
  TicketImportFile,
  TicketStatus,
  type LimitExceeded,
  type SettingName,
  type TicketImportBlocker,
  type TicketImportPreview,
  type TicketImportProblem,
} from '@orchestrator/protocol';
import type { z } from 'zod';
import type { Executor } from '../database.js';
import { recordEvent } from '../events.js';
import type { ProjectRow } from '../projects/model.js';
import { ticketReference, type TicketRow } from './model.js';
import { completeOwnerTicket, insertNumberedTicket } from './rules.js';
import { checkTickets, type PlannedTicket, type TicketProblem } from './ticket-checks.js';

/*
 * Import of a file of tickets on a project's board (02, section 6.3; 06, section 4.6; lot 5bis
 * step A). The preview and the import check the file the same way; the import then creates every
 * ticket in one transaction, under the project's lock taken by the caller, or none. Problems are
 * written for the owner, each located by the ticket's position and key and by the field.
 */

/** The owner's words (lot 5bis step A, decision 4). */
export const ASSIGNED_WARNING =
  'Assigned tickets can be started by the scheduler right away. Pause the account first if you do not want that.';

const FIELDS = Object.keys(TicketImportEntry.shape);

type Located = Omit<TicketImportProblem, 'message'>;
const WHOLE_FILE: Located = { position: null, key: null, field: null };

/** A sentence: capital first letter, final full stop. */
function sentence(text: string): string {
  const trimmed = text.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

function problem(at: Located, message: string): TicketImportProblem {
  return { ...at, message: sentence(message) };
}

/** "the setting “Longest ticket title”", as Settings > Limits names it. */
function settingWords(name: SettingName): string {
  return `the setting “${SETTINGS[name].label}”`;
}

/** Where `syntaxErrorOffset` stopped reading. */
class JsonStop extends Error {
  constructor(readonly offset: number) {
    super(`JSON stops at ${String(offset)}`);
  }
}

/**
 * Offset of the first character JSON.parse refuses, found by a small reader of JSON's grammar:
 * V8 does not always say where. Null when it finds no error or cannot tell.
 */
function syntaxErrorOffset(text: string): number | null {
  let at = 0;
  const literal = /true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const space = () => {
    while (at < text.length && ' \t\n\r'.includes(text.charAt(at))) at++;
  };
  const fail = (): never => {
    throw new JsonStop(at);
  };
  const string = () => {
    at++;
    while (at < text.length && text.charAt(at) !== '"') {
      if (text.charCodeAt(at) < 0x20) fail();
      at += text.charAt(at) === '\\' ? 2 : 1;
    }
    if (at >= text.length) fail();
    at++;
  };
  const value = (): void => {
    space();
    const open = text.charAt(at);
    if (open === '{' || open === '[') {
      const close = open === '{' ? '}' : ']';
      at++;
      space();
      if (text.charAt(at) === close) {
        at++;
        return;
      }
      for (;;) {
        if (open === '{') {
          space();
          if (text.charAt(at) !== '"') fail();
          string();
          space();
          if (text.charAt(at) !== ':') fail();
          at++;
        }
        value();
        space();
        if (text.charAt(at) === ',') at++;
        else if (text.charAt(at) === close) {
          at++;
          return;
        } else fail();
      }
    }
    if (open === '"') {
      string();
      return;
    }
    literal.lastIndex = at;
    const match = literal.exec(text);
    if (!match) fail();
    at += match?.[0].length ?? 0;
  };
  try {
    value();
    space();
    if (at < text.length) fail();
  } catch (error) {
    // Anything else (a stack overflow on a deeply nested text) tells nothing.
    return error instanceof JsonStop ? error.offset : null;
  }
  return null;
}

/** Where JSON.parse stopped, as "line 4, column 5". */
function jsonPlace(text: string): string | null {
  const offset = syntaxErrorOffset(text);
  if (offset === null) return null;
  const lines = text.slice(0, offset).split('\n');
  return `line ${String(lines.length)}, column ${String((lines.at(-1)?.length ?? 0) + 1)}`;
}

function valueAt(value: unknown, path: readonly PropertyKey[]): unknown {
  let current = value;
  for (const part of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<PropertyKey, unknown>)[part];
  }
  return current;
}

function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'string') return 'a text';
  if (typeof value === 'number') return 'a number';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return 'an object';
}

const expectedWords: Record<string, string> = {
  string: 'a text in quotes',
  array: 'a list in square brackets',
  object: 'an object in curly brackets',
  number: 'a number',
};

/** Each problem of the file's form, located. */
function formProblems(raw: unknown, issues: readonly z.core.$ZodIssue[]): TicketImportProblem[] {
  const problems: TicketImportProblem[] = [];
  for (const issue of issues) {
    const [first, index, field, ...rest] = issue.path;
    const inTicket = first === 'tickets' && typeof index === 'number';
    const rawKey = inTicket ? valueAt(raw, ['tickets', index, 'key']) : undefined;
    const at: Located = inTicket
      ? {
          position: index + 1,
          key: typeof rawKey === 'string' ? rawKey : null,
          field: typeof field === 'string' ? field : null,
        }
      : { ...WHOLE_FILE, field: typeof first === 'string' ? first : null };
    const item = typeof rest[0] === 'number' ? rest[0] : null;
    const prefix =
      item === null
        ? ''
        : field === 'acceptance_criteria'
          ? `criterion ${String(item + 1)}: `
          : `entry ${String(item + 1)}: `;
    const value = valueAt(raw, issue.path);

    if (issue.code === 'unrecognized_keys') {
      const allowed = inTicket ? FIELDS : ['format', 'tickets'];
      for (const unknown of issue.keys) {
        problems.push(
          problem(
            { ...at, field: unknown },
            `unknown field “${unknown}”: remove it or correct its spelling. The fields are ${allowed.join(', ')}`,
          ),
        );
      }
      continue;
    }
    let message: string;
    if (value === undefined && issue.code !== 'too_small') {
      message = 'this field is missing';
    } else if (issue.code === 'invalid_type') {
      message = `must be ${expectedWords[issue.expected] ?? issue.expected}, not ${kindOf(value)}`;
    } else if (issue.code === 'invalid_value' && at.field !== 'format') {
      message = `“${String(value)}” is not possible: use one of ${issue.values.map(String).join(', ')}`;
    } else if (issue.code === 'too_big' && issue.origin === 'array') {
      message =
        first === 'tickets' && !inTicket
          ? `the file has more than ${String(issue.maximum)} tickets`
          : `at most ${String(issue.maximum)} entries`;
    } else {
      message = issue.message;
    }
    problems.push(problem(at, prefix + message));
  }
  return problems;
}

/** Reads the text as the format: the file, or its problems (nothing checked against the project). */
export function readImportFile(
  text: string,
): { file: TicketImportFile; problems: [] } | { file: null; problems: TicketImportProblem[] } {
  if (text.trim() === '') {
    return {
      file: null,
      problems: [problem(WHOLE_FILE, 'Paste the text of the file, or choose a .json file')],
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    const place = jsonPlace(text);
    return {
      file: null,
      problems: [
        problem(
          WHOLE_FILE,
          `the text is not valid JSON${place ? ` (${place})` : ''}: check the commas, quotes and brackets${place ? ' around there' : ''}`,
        ),
      ],
    };
  }
  const parsed = TicketImportFile.safeParse(raw);
  if (!parsed.success) return { file: null, problems: formProblems(raw, parsed.error.issues) };
  return { file: parsed.data, problems: [] };
}

const limitSetting: Record<LimitExceeded['field'], SettingName> = {
  title: 'ticketTitleMaxLength',
  description: 'ticketDescriptionMaxLength',
  acceptance_criteria: 'ticketMaxAcceptanceCriteria',
  acceptance_criterion: 'acceptanceCriterionMaxLength',
  comment: 'commentMaxLength',
  request: 'ticketDescriptionMaxLength',
};

function limitMessage(limit: LimitExceeded, entry: TicketImportEntry): string {
  const setting = settingWords(limitSetting[limit.field]);
  switch (limit.field) {
    case 'acceptance_criteria':
      return `${String(entry.acceptance_criteria?.length ?? 0)} criteria: at most ${String(limit.max)}, ${setting}`;
    case 'acceptance_criterion': {
      const criterion = entry.acceptance_criteria?.[limit.index ?? 0] ?? '';
      return `criterion ${String((limit.index ?? 0) + 1)} is too long: ${String(criterion.length)} characters, at most ${String(limit.max)}, ${setting}`;
    }
    default: {
      const length = (limit.field === 'title' ? entry.title : (entry.description ?? '')).length;
      return `too long: ${String(length)} characters, at most ${String(limit.max)}, ${setting}`;
    }
  }
}

/** A problem of the shared checks in the owner's words. */
function ownerProblem(found: TicketProblem, file: TicketImportFile): TicketImportProblem {
  const at: Located = { position: found.position, key: found.key, field: found.field };
  const entry = found.position === null ? undefined : file.tickets[found.position - 1];
  switch (found.code) {
    case 'too_many':
      return problem(
        at,
        `the file has ${String(found.count)} tickets: at most ${String(found.max)} can be imported at once, ${settingWords('maxTicketsPerPlan')}. Split the file in two`,
      );
    case 'duplicate_key':
      return problem(
        at,
        `the key “${found.key ?? ''}” is already the key of ticket ${String(found.earlier)}: each key must be used once in the file`,
      );
    case 'limit':
      if (!entry) throw new Error('a limit problem without its ticket');
      return problem(at, limitMessage(found.limit, entry));
    case 'assignee':
      return problem(
        at,
        `${found.refusal}. The agents you can assign are ${found.assignable || 'none'}`,
      );
    case 'blocks_itself':
      return problem(
        at,
        `“${found.item}” is this ticket's own key: a ticket cannot wait for itself`,
      );
    case 'unknown_key':
      return problem(at, `no ticket of the file has the key “${found.item}”`);
    case 'other_project':
      return problem(
        at,
        `${found.item} belongs to another project: a ticket can only wait for tickets of ${found.project}`,
      );
    case 'unknown_ticket':
      return problem(at, `there is no ticket ${found.item} in this project`);
    case 'no_project':
      // An import always has its project.
      throw new Error('an import without its project');
    case 'not_a_reference':
      return problem(
        at,
        `“${found.item}” is neither a key of this file nor a ticket number such as ${found.project ?? 'WEB'}-3`,
      );
    case 'cycle':
      return problem(
        at,
        `these tickets wait for each other, so none of them could ever start: ${found.label}. Remove one of these dependencies`,
      );
  }
}

/**
 * Checks the file against the project and the current settings, writing nothing: the preview,
 * and the tickets to create when there is no problem. `executor` is the caller's transaction,
 * under the project's lock for an import.
 */
export async function checkImport(
  executor: Executor,
  project: ProjectRow,
  file: TicketImportFile,
): Promise<{ preview: TicketImportPreview; planned: PlannedTicket[] | null }> {
  const checked = await checkTickets(executor, project, file.tickets);
  const problems = checked.problems.map((found) => ownerProblem(found, file));
  const { planned } = checked;

  // The owner's warnings (lot 5bis step A, decision 4): assigned tickets, cancelled blockers.
  const warnings: string[] = [];
  if (file.tickets.some((entry) => entry.assignee)) warnings.push(ASSIGNED_WARNING);
  for (const each of planned) {
    for (const row of each.existingBlockers) {
      if (TicketStatus.parse(row.status) === 'cancelled') {
        warnings.push(
          `${each.key} is blocked by ${ticketReference(project.key, row.number)}, which is cancelled: it will stay blocked until you remove that dependency.`,
        );
      }
    }
  }

  const titleOfKey = new Map(file.tickets.map((entry) => [entry.key, entry.title]));
  const preview: TicketImportPreview = {
    tickets: planned.map((each, index) => ({
      position: index + 1,
      key: each.key,
      type: each.ticket.type,
      title: each.ticket.title,
      priority: each.ticket.priority,
      assignee: each.ticket.assignee
        ? { key: each.ticket.assignee.key, name: each.ticket.assignee.name }
        : null,
      criteria: each.ticket.acceptanceCriteria.length,
      blockedBy: [
        ...each.fileBlockers.map((key): TicketImportBlocker => ({
          kind: 'file',
          key,
          title: titleOfKey.get(key) ?? '',
        })),
        ...each.existingBlockers.map((row): TicketImportBlocker => ({
          kind: 'ticket',
          number: row.number,
          title: row.title,
          status: TicketStatus.parse(row.status),
        })),
      ],
    })),
    problems: sortProblems(problems),
    warnings,
  };
  return { preview, planned: problems.length === 0 ? planned : null };
}

/** The whole file's problems first, then by ticket, each ticket's in the order found. */
function sortProblems(problems: TicketImportProblem[]): TicketImportProblem[] {
  return problems
    .map((each, order) => ({ each, order }))
    .sort((a, b) => (a.each.position ?? 0) - (b.each.position ?? 0) || a.order - b.order)
    .map(({ each }) => each);
}

/**
 * Creates the checked tickets in `todo`, numbered in the file's order, then their dependencies,
 * each `ticket.created`, and `tickets.imported`. In the caller's transaction, under the project's
 * lock.
 */
export async function importTickets(
  tx: Executor,
  project: ProjectRow,
  planned: readonly PlannedTicket[],
  at: Date,
): Promise<TicketRow[]> {
  const rows: TicketRow[] = [];
  for (const each of planned) rows.push(await insertNumberedTicket(tx, project, each.ticket, at));
  const rowByKey = new Map(planned.map((each, index) => [each.key, rows[index] as TicketRow]));
  for (const [index, each] of planned.entries()) {
    const blockers = [
      ...each.fileBlockers.map((key) => rowByKey.get(key) as TicketRow),
      ...each.existingBlockers,
    ];
    await completeOwnerTicket(
      tx,
      project,
      rows[index] as TicketRow,
      each.ticket.assignee,
      blockers,
      at,
    );
  }
  await recordEvent(tx, {
    actor: 'owner',
    entityType: 'project',
    entityId: project.id,
    projectId: project.id,
    type: 'tickets.imported',
    payload: {
      key: project.key,
      count: rows.length,
      tickets: rows.map((row) => ticketReference(project.key, row.number)),
    },
    at,
  });
  return rows;
}
