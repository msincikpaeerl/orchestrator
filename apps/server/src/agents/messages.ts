import {
  FIRST_MESSAGE_MAX_BYTES,
  type CommentKind,
  type RunPurpose,
  type TicketPriority,
  type TicketStatus,
  type TicketType,
} from '@orchestrator/protocol';
import { PURPOSE_RULES, type Rules, type Template, type Templates } from './files.js';

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
 * Layer 1 of 03, section 3, for a run of this purpose: the shared rules, with their slots filled
 * in by the builder or the reviewer rules (owner's answers 1 and 3, lot 3 step H5).
 */
export function runRules(rules: Rules, purpose: RunPurpose): string {
  const kind = PURPOSE_RULES[purpose];
  if (kind === null) throw new Error(`no rules for ${purpose} runs before lot 5`);
  const own = rules[kind];
  return fill(rules.shared, rules.shared.main, {
    work: own.main,
    files: part(own, 'files'),
    needs: part(own, 'needs'),
    task: part(own, 'task'),
  });
}

/**
 * What Claude Code's system prompt receives (03, section 3): the run's rules, the role, then the
 * profile's Bash rules as the allowlist template lists them.
 */
export function runInstructions(
  runRulesText: string,
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
  return `${runRulesText.trim()}\n\n${roleInstructions.trim()}\n\n${section.trim()}\n`;
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
  previousCi?:
    { kind: 'failed' } | { kind: 'failed_unsent' } | { kind: 'conflict'; base: string } | null;
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
export function timestamp(at: Date): string {
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
  const base = ticket.earlierWorkBase;
  const opening =
    base === null
      ? part(template, 'start')
      : ticket.notPushed === null
        ? part(template, 'start-earlier-work', { base })
        : notPushedStart(template, ticket.notPushed, base);
  return firstMessage(template, ticket, opening, null, {}, maxBytes);
}

/** One point of a request for changes, as the `fix_review` run reads it. */
export interface FixPoint {
  body: string;
  file: string | null;
  line: number | null;
}

/**
 * Layer 3 of 03, section 3, for a `fix_review` run (owner's answers 3 and 5, lot 3 step I): the
 * ticket as for `implement`, the request it addresses and where its work is.
 */
export interface FixReviewTicket extends ImplementTicket {
  /** Quality's request (its points), or the owner's (the comment, whole). */
  request:
    | { by: 'quality'; at: Date; commit: string; points: readonly FixPoint[] }
    | { by: 'owner'; at: Date; comment: string };
  /** The ticket's branch, and its pull request; null for a ticket left by 0.3.0. */
  branch: string;
  /** The base branch as the worktree names it: `origin/main`. */
  base: string;
  pullRequest: number | null;
  /** The machine holding the work was revoked and nothing was pushed: the branch starts again. */
  lost: boolean;
}

/**
 * The first message of a `fix_review` run (owner's answers 3 to 5, lot 3 step I), from
 * `fix-review.md` and the parts it shares with `implement.md` (the starts of work not pushed or
 * diverged, the sentences after CI, the ticket's pieces). Comments go first when it is too long,
 * then the last points (with their number), then the description is cut.
 */
export function fixReviewFirstMessage(
  fix: Template,
  implement: Template,
  ticket: FixReviewTicket,
  maxBytes = FIRST_MESSAGE_MAX_BYTES,
): string {
  const template: Template = {
    name: fix.name,
    main: fix.main,
    parts: new Map([...implement.parts, ...fix.parts]),
  };
  const { base } = ticket;
  const opening = ticket.lost
    ? part(template, 'start-lost', { branch: ticket.branch, base })
    : ticket.notPushed !== null
      ? notPushedStart(template, ticket.notPushed, base)
      : ticket.pullRequest === null
        ? part(template, 'start-no-pull-request', { branch: ticket.branch, base })
        : part(template, 'start', {
            branch: ticket.branch,
            base,
            pull_request: String(ticket.pullRequest),
          });
  const { request } = ticket;
  const heading =
    request.by === 'quality'
      ? part(template, 'request-quality', { at: timestamp(request.at), commit: request.commit })
      : part(template, 'request-owner', { at: timestamp(request.at) });
  const points =
    request.by === 'quality'
      ? request.points.map((point, index) => {
          const values = { index: String(index + 1), body: point.body.trim() };
          if (point.file === null) return part(template, 'point', values);
          if (point.line === null)
            return part(template, 'point-file', { ...values, file: point.file });
          return part(template, 'point-line', {
            ...values,
            file: point.file,
            line: String(point.line),
          });
        })
      : [request.comment.trim()];
  // The owner's request comes after the acceptance criteria (owner's answer 14, lot 4 step A).
  const afterCriteria = request.by === 'owner' ? `${part(template, 'after-criteria')}\n\n` : '';
  return firstMessage(
    template,
    ticket,
    opening,
    points,
    { request: heading, after_criteria: afterCriteria },
    maxBytes,
  );
}

function notPushedStart(
  template: Template,
  notPushed: { branch: string; diverged: boolean },
  base: string,
): string {
  return part(template, notPushed.diverged ? 'start-diverged' : 'start-not-pushed', {
    base,
    branch: notPushed.branch,
  });
}

/**
 * A builder run's first message within `maxBytes`: the ticket in full, the points of a
 * `fix_review` run, then the comments from the newest while they fit; then the last points go,
 * with their number; then the description is cut at a line boundary.
 */
function firstMessage(
  template: Template,
  ticket: ImplementTicket,
  opening: string,
  points: readonly string[] | null,
  extra: Record<string, string>,
  maxBytes: number,
): string {
  const criteria =
    ticket.acceptanceCriteria.length === 0
      ? part(template, 'no-criteria')
      : ticket.acceptanceCriteria
          .map((text, index) =>
            part(template, 'criterion', { number: String(index + 1), index: String(index), text }),
          )
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
  const previous = ticket.previousCi ?? null;
  const start =
    previous === null
      ? opening
      : `${opening}\n\n${
          previous.kind === 'failed'
            ? part(template, 'after-ci-failed')
            : previous.kind === 'failed_unsent'
              ? part(template, 'after-ci-failed-unsent')
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
  const allPoints = points ?? [];

  /** The message with the newest `kept` comments, the first `shownPoints` and the description. */
  const render = (kept: number, description: string, shownPoints = allPoints.length) => {
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
    const pointValues: Record<string, string> =
      points === null
        ? {}
        : {
            points: [
              ...allPoints.slice(0, shownPoints),
              ...(shownPoints < allPoints.length
                ? [
                    part(template, 'points-left-out', {
                      count: String(allPoints.length - shownPoints),
                    }),
                  ]
                : []),
            ].join('\n'),
          };
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
      ...extra,
      ...pointValues,
    })}\n`;
  };
  const fits = (text: string) => bytes(text) <= maxBytes;
  /** The largest count from 0 to `most` for which `ok` holds, `ok` holding for every smaller one. */
  const largest = (most: number, ok: (count: number) => boolean) => {
    let low = 0;
    let high = most;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (ok(middle)) low = middle;
      else high = middle - 1;
    }
    return low;
  };

  const description = ticket.description.trim();
  const fullDescription = description === '' ? part(template, 'empty-description') : description;
  // The most comments that fit: fewer comments always make a shorter message.
  const kept = largest(renderedComments.length, (count) => fits(render(count, fullDescription)));
  if (fits(render(kept, fullDescription))) return render(kept, fullDescription);
  // Without comments: the first points that fit, at least one.
  const shownPoints = Math.max(
    1,
    largest(allPoints.length, (count) => fits(render(0, fullDescription, count))),
  );
  if (fits(render(0, fullDescription, shownPoints))) return render(0, fullDescription, shownPoints);

  // Still too long: cut the description at a line boundary.
  const lines = description.split('\n');
  const cut = (count: number) =>
    [lines.slice(0, count).join('\n').trimEnd(), part(template, 'description-cut')]
      .filter((text) => text !== '')
      .join('\n\n');
  const kept2 = largest(lines.length - 1, (count) =>
    fits(render(0, cut(count), Math.min(1, allPoints.length))),
  );
  const message = render(0, cut(kept2), Math.min(1, allPoints.length));
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

/**
 * Sent by the daemon when a turn ends without a decision (05, section 4.8); a review run's names
 * the review tools (lot 3 step H).
 */
export function nudgeMessage(templates: Templates, purpose: RunPurpose = 'implement'): string {
  const text = purpose === 'review' ? part(templates.nudge, 'review') : templates.nudge.main;
  return `${fill(templates.nudge, text, {})}\n`;
}

/**
 * The line a run started by the scheduler begins with, followed by a blank line; empty for one the
 * owner started (lot 4 step D2a). Its bytes count in the first message's budget.
 */
export function startedBy(template: Template, scheduler: boolean): string {
  return scheduler ? `${part(template, 'started-by-scheduler').trim()}\n\n` : '';
}
