import {
  FIRST_MESSAGE_MAX_BYTES,
  type CommentKind,
  type TicketPriority,
  type TicketStatus,
  type TicketType,
} from '@orchestrator/protocol';
import type { Template, Templates } from './files.js';

// Filling in the run message templates of `agents/templates/` (03, section 3.2). Every text an
// agent reads comes from those files; this module only puts the values in their place.

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/**
 * Fills in `{{name}}` markers in one pass, so a value containing `{{x}}` (a ticket description
 * can) is kept as written. A marker without a value is a mistake in the template and throws.
 */
export function fill(template: Template, text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (marker, name: string) => {
    if (!Object.hasOwn(values, name)) {
      throw new Error(`template ${template.name}: no value for ${marker}`);
    }
    return values[name] as string;
  });
}

export function part(
  template: Template,
  name: string,
  values: Record<string, string> = {},
): string {
  const text = template.parts.get(name);
  if (text === undefined) throw new Error(`template ${template.name}: part ${name} is missing`);
  return fill(template, text, values);
}

/**
 * What Claude Code's system prompt receives (03, section 3): the common rules, the role, then the
 * profile's Bash rules as the allowlist template lists them.
 */
export function runInstructions(
  commonRules: string,
  roleInstructions: string,
  allowlist: Template,
  allowedTools: readonly string[],
): string {
  const rules = allowedTools.flatMap((tool) => /^Bash\((.+)\)$/.exec(tool)?.[1] ?? []);
  const commands =
    rules.length === 0
      ? part(allowlist, 'no-commands')
      : rules.map((rule) => part(allowlist, 'command', { rule })).join('\n');
  const section = fill(allowlist, allowlist.main, { commands });
  return `${commonRules.trim()}\n\n${roleInstructions.trim()}\n\n${section.trim()}\n`;
}

export interface FirstMessageComment {
  author: { kind: 'owner' } | { kind: 'system' } | { kind: 'agent'; name: string };
  kind: CommentKind;
  at: Date;
  body: string;
}

/** Layer 3 of 03, section 3, for an `implement` run. */
export interface ImplementTicket {
  projectName: string;
  /** `WEB-12`. */
  reference: string;
  title: string;
  type: TicketType;
  priority: TicketPriority;
  description: string;
  acceptanceCriteria: readonly string[];
  dependencies: readonly { reference: string; title: string; status: TicketStatus }[];
  /** Oldest first. */
  comments: readonly FirstMessageComment[];
  /** This run's attempt at the ticket, from 1. */
  attempt: number;
  /**
   * The base branch as the worktree names it (`origin/main`) when the ticket branch already holds
   * commits from an earlier attempt: the agent reads them and continues. Null otherwise.
   */
  earlierWorkBase: string | null;
  /**
   * The ticket branch's latest push failed and no push was done since (04, section 5; lot 3 step
   * F): the work is committed but not on GitHub. `diverged`: GitHub's branch has commits this
   * machine lacks, which the agent merges first. Null otherwise.
   */
  notPushed: { branch: string; diverged: boolean } | null;
  /**
   * How the ticket's previous run ended on CI (owner's answer 8 and addition 4, lot 3 step G2b):
   * `ci_failed`, or a conflict with the base branch left unresolved (`ci_failed` or `ci_timeout`
   * on a conflict). Null otherwise.
   */
  previousCi?: { kind: 'failed' } | { kind: 'conflict'; base: string } | null;
}

/** The ticket alone does not fit, even with its description cut to nothing (03, section 3.2). */
export class FirstMessageTooLarge extends Error {
  constructor(reference: string) {
    super(
      `The first message of ${reference} does not fit ${String(FIRST_MESSAGE_MAX_BYTES)} bytes even without its description`,
    );
    this.name = 'FirstMessageTooLarge';
  }
}

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

/** `2026-09-27 14:03 UTC`. */
function timestamp(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * The first message of an `implement` run, within `FIRST_MESSAGE_MAX_BYTES` (03, section 3.2): the
 * ticket in full, then its comments from the newest while they fit, with the number left out; if
 * the ticket alone is too long, its description is cut at a line boundary, followed by the
 * template's marker pointing to `ticket_get`.
 */
export function implementFirstMessage(
  template: Template,
  ticket: ImplementTicket,
  maxBytes = FIRST_MESSAGE_MAX_BYTES,
): string {
  const criteria =
    ticket.acceptanceCriteria.length === 0
      ? part(template, 'no-criteria')
      : ticket.acceptanceCriteria
          .map((text, index) => part(template, 'criterion', { index: String(index), text }))
          .join('\n');
  const dependencies =
    ticket.dependencies.length === 0
      ? part(template, 'no-dependencies')
      : ticket.dependencies
          .map((link) =>
            part(template, 'dependency', {
              ticket: link.reference,
              title: link.title,
              status: link.status,
            }),
          )
          .join('\n');
  const base = ticket.earlierWorkBase;
  const opening =
    base === null
      ? part(template, 'start')
      : ticket.notPushed === null
        ? part(template, 'start-earlier-work', { base })
        : part(template, ticket.notPushed.diverged ? 'start-diverged' : 'start-not-pushed', {
            base,
            branch: ticket.notPushed.branch,
          });
  const previous = ticket.previousCi ?? null;
  const start =
    previous === null
      ? opening
      : `${opening}\n\n${
          previous.kind === 'failed'
            ? part(template, 'after-ci-failed')
            : part(template, 'after-conflict', { base: previous.base })
        }`;
  const renderedComments = ticket.comments.map((comment) =>
    part(template, 'comment', {
      author:
        comment.author.kind === 'agent'
          ? part(template, 'author-agent', { name: comment.author.name })
          : part(template, `author-${comment.author.kind}`),
      kind: comment.kind,
      at: timestamp(comment.at),
      body: comment.body.trim(),
    }),
  );

  /** The message with the newest `kept` comments and the given description. */
  const render = (kept: number, description: string) => {
    const leftOut = renderedComments.length - kept;
    const shown = renderedComments.slice(leftOut);
    const comments =
      renderedComments.length === 0
        ? part(template, 'no-comments')
        : [
            ...(leftOut > 0
              ? [part(template, 'comments-left-out', { count: String(leftOut) })]
              : []),
            ...shown,
          ].join('\n\n');
    return `${fill(template, template.main, {
      ticket: ticket.reference,
      project_name: ticket.projectName,
      attempt: String(ticket.attempt),
      start,
      title: ticket.title,
      type: ticket.type,
      priority: ticket.priority,
      description,
      acceptance_criteria: criteria,
      dependencies,
      comments,
    })}\n`;
  };
  const fits = (text: string) => bytes(text) <= maxBytes;

  const description = ticket.description.trim();
  const fullDescription = description === '' ? part(template, 'empty-description') : description;
  if (fits(render(renderedComments.length, fullDescription))) {
    return render(renderedComments.length, fullDescription);
  }
  // The most comments that fit: fewer comments always make a shorter message.
  let low = 0;
  let high = renderedComments.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(render(middle, fullDescription))) low = middle;
    else high = middle - 1;
  }
  if (fits(render(low, fullDescription))) return render(low, fullDescription);

  // Without comments the ticket still does not fit: cut the description at a line boundary.
  const lines = description.split('\n');
  const cut = (count: number) =>
    [lines.slice(0, count).join('\n').trimEnd(), part(template, 'description-cut')]
      .filter((text) => text !== '')
      .join('\n\n');
  low = 0;
  high = lines.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(render(0, cut(middle)))) low = middle;
    else high = middle - 1;
  }
  const message = render(0, cut(low));
  if (!fits(message)) throw new FirstMessageTooLarge(ticket.reference);
  return message;
}

/** The owner's answer to a question, live (`run.input`) or on resume (`run.resume`). */
export function answerMessage(templates: Templates, question: string, answer: string): string {
  const template = templates.answer;
  return `${fill(template, template.main, { question: question.trim(), answer: answer.trim() })}\n`;
}

/**
 * The owner's answer delivered with `run.resume`, a command-line argument within `maxBytes` (03,
 * section 3.2): when it does not fit, the question is cut first at a line boundary, down to its
 * marker alone, then the answer the same way; each cut ends with its marker from the template.
 */
export function answerResumeMessage(
  templates: Templates,
  question: string,
  answer: string,
  maxBytes = FIRST_MESSAGE_MAX_BYTES,
): string {
  const template = templates.answer;
  const render = (q: string, a: string) =>
    `${fill(template, template.main, { question: q, answer: a })}\n`;
  const fits = (text: string) => bytes(text) <= maxBytes;
  const q = question.trim();
  const a = answer.trim();
  if (fits(render(q, a))) return render(q, a);

  /** The first `count` lines of `text`, then the marker. */
  const cutText = (text: string, count: number, marker: string) =>
    [text.split('\n').slice(0, count).join('\n').trimEnd(), part(template, marker)]
      .filter((each) => each !== '')
      .join('\n\n');
  /** The most lines of `text` for which `build` still fits; -1 when none does. */
  const most = (text: string, build: (count: number) => string) => {
    let low = 0;
    let high = text.split('\n').length - 1;
    if (!fits(build(0))) return -1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(build(middle))) low = middle;
      else high = middle - 1;
    }
    return low;
  };

  const questionLines = most(q, (count) => render(cutText(q, count, 'question-cut'), a));
  if (questionLines >= 0) return render(cutText(q, questionLines, 'question-cut'), a);
  const shortQuestion = cutText(q, 0, 'question-cut');
  const answerLines = most(a, (count) => render(shortQuestion, cutText(a, count, 'answer-cut')));
  if (answerLines < 0) throw new Error('the answer template alone does not fit');
  return render(shortQuestion, cutText(a, answerLines, 'answer-cut'));
}

/** Sent with `run.resume` after a pause on a usage limit, detected or suspected. */
export function continueMessage(templates: Templates): string {
  return `${fill(templates.continue, templates.continue.main, {})}\n`;
}

/** Sent by the daemon when a turn ends without a decision (05, section 4.8). */
export function nudgeMessage(templates: Templates): string {
  return `${fill(templates.nudge, templates.nudge.main, {})}\n`;
}
