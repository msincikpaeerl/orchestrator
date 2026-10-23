import {
  FIRST_MESSAGE_MAX_BYTES,
  type StoredDodReport,
  type TicketPriority,
  type TicketStatus,
  type TicketType,
} from '@orchestrator/protocol';
import type { Template } from './files.js';
import {
  FirstMessageTooLarge,
  fill,
  part,
  timestamp,
  type FirstMessageComment,
  type FixPoint,
} from './messages.js';

// The first message of a `review` run (03, section 3.1; owner's answers 4 and 5, lot 3 step H):
// the commit under review, CI, the ticket, the agent's report, earlier reviews and comments, from
// the template `review`. Like an `implement` run's, within `FIRST_MESSAGE_MAX_BYTES`.

/** What the review is told about CI: never that it failed or did not finish (answer 4). */
export type ReviewCi = 'passed' | 'passed_later' | 'no_ci';

/** The request a review run's work answers, as its first message gives it (lot 3 step I). */
export type PreviousReview = (
  | {
      by: 'quality';
      at: Date;
      commit: string;
      /** Its round; null for a request made before **Try again** or **Reopen** (step I2). */
      round: number | null;
      limit: number;
      points: readonly FixPoint[];
    }
  | {
      by: 'owner';
      at: Date;
      commit: string | null;
      after: 'approved' | 'skipped' | null;
      comment: string;
    }
) & {
  /** The agent's comments since the request, oldest first. */
  notes: readonly Omit<FirstMessageComment, 'kind'>[];
};

/** Layer 3 of 03, section 3, for a `review` run. */
export interface ReviewTicket {
  projectName: string;
  reference: string;
  title: string;
  type: TicketType;
  priority: TicketPriority;
  description: string;
  acceptanceCriteria: readonly string[];
  dependencies: readonly { reference: string; title: string; status: TicketStatus }[];
  /** Oldest first, without the `review` comments. */
  comments: readonly FirstMessageComment[];
  /** The ticket's `review` comments, oldest first, without the previous review's. */
  earlierReviews: readonly Omit<FirstMessageComment, 'kind'>[];
  /**
   * The request for changes the work in review answers (owner's answer 4, lot 3 step I): its
   * points or comment, and what the agent said about them since; null when none.
   */
  previous: PreviousReview | null;
  /** The commit under review, fixed at **Start review**. */
  commit: string;
  pullRequest: { number: number; url: string };
  base: string;
  ci: ReviewCi;
  /** The ticket's workflow flag: `changed`, `not_listed` (may have changed), or none. */
  workflows: 'changed' | 'not_listed' | null;
  /** The accepted submission's report. */
  report: StoredDodReport;
}

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

function author(template: Template, who: FirstMessageComment['author']): string {
  return who.kind === 'agent'
    ? part(template, 'author-agent', { name: who.name })
    : part(template, `author-${who.kind}`);
}

function ciSection(template: Template, ticket: ReviewTicket): string {
  const values = { commit: ticket.commit };
  if (ticket.ci === 'no_ci') {
    // One sentence for both facts (owner's answer 3, lot 3 step G1).
    if (ticket.workflows === 'changed') return part(template, 'no-ci-workflows', values);
    const noCi = part(template, 'no-ci', values);
    return ticket.workflows === 'not_listed'
      ? `${noCi}\n\n${part(template, 'workflows-maybe')}`
      : noCi;
  }
  const passed = part(template, ticket.ci === 'passed' ? 'ci-passed' : 'ci-passed-later', values);
  if (ticket.workflows === null) return passed;
  return `${passed}\n\n${part(template, ticket.workflows === 'changed' ? 'workflows-changed' : 'workflows-maybe')}`;
}

/**
 * "## The previous review" (owner's answer 4 and addition, lot 3 step I), in pieces the byte
 * budget cuts (owner's answer 1, step I2): Quality's points or the owner's request by lines, and
 * the agent's notes.
 */
interface PreviousPieces {
  /** Quality's points one by one, or the owner's request line by line. */
  items: string[];
  notes: string[];
  /** The section with the first `shown` items and the newest `notesKept` notes. */
  render: (shown: number, notesKept: number) => string;
}

function previous(
  template: Template,
  ticket: ReviewTicket,
  request: PreviousReview,
): PreviousPieces {
  const answer = [
    part(template, 'previous-answer'),
    ...(request.commit === null
      ? []
      : [part(template, 'previous-diff', { commit: request.commit })]),
    part(template, 'previous-rest', { head: ticket.commit }),
  ].join(' ');
  const at = timestamp(request.at);
  const items =
    request.by === 'quality'
      ? request.points.map((point, index) => {
          const values = { index: String(index + 1), body: point.body.trim() };
          if (point.file === null) return part(template, 'previous-point', values);
          if (point.line === null) {
            return part(template, 'previous-point-file', { ...values, file: point.file });
          }
          return part(template, 'previous-point-line', {
            ...values,
            file: point.file,
            line: String(point.line),
          });
        })
      : request.comment.trim().split('\n');
  const notes = request.notes.map((note) =>
    part(template, 'previous-note', {
      author: author(template, note.author),
      at: timestamp(note.at),
      body: note.body.trim(),
    }),
  );
  const requestText = (shown: number) => {
    if (request.by === 'quality') {
      const points = [
        ...items.slice(0, shown),
        ...(shown < items.length
          ? [part(template, 'previous-points-left-out', { count: String(items.length - shown) })]
          : []),
      ].join('\n');
      return part(template, 'previous-quality', {
        commit: request.commit,
        at,
        round:
          request.round === null
            ? ''
            : part(template, 'previous-round', {
                round: String(request.round),
                limit: String(request.limit),
              }),
        answer,
        points,
      });
    }
    const on =
      request.commit === null
        ? ''
        : part(template, request.after === null ? 'previous-on' : `previous-on-${request.after}`, {
            commit: request.commit,
          });
    const comment =
      shown < items.length
        ? [items.slice(0, shown).join('\n').trimEnd(), part(template, 'previous-owner-cut')]
            .filter((text) => text !== '')
            .join('\n\n')
        : items.join('\n');
    return part(template, 'previous-owner', { at, on, comment, answer });
  };
  const notesText = (kept: number) => {
    if (notes.length === 0) return part(template, 'previous-no-notes');
    const leftOut = notes.length - kept;
    return [
      ...(leftOut > 0
        ? [part(template, 'previous-notes-left-out', { count: String(leftOut) })]
        : []),
      ...notes.slice(leftOut),
    ].join('\n\n');
  };
  return {
    items,
    notes,
    render: (shown, notesKept) =>
      part(template, 'previous-review', {
        request: requestText(shown),
        notes: notesText(notesKept),
      }),
  };
}

function files(template: Template, listed: { paths: string[]; justification: string | null }) {
  if (listed.paths.length === 0) {
    return part(template, 'no-paths', { justification: listed.justification ?? '' });
  }
  return listed.paths
    .map((path) => part(template, 'path', { path }))
    .join(part(template, 'path-separator'));
}

function report(template: Template, ticket: ReviewTicket): string {
  const { report: submitted } = ticket;
  const criteria =
    submitted.criteria.length === 0
      ? part(template, 'no-report-criteria')
      : submitted.criteria
          .map((criterion) =>
            part(template, 'report-criterion', {
              number: String(criterion.index + 1),
              status: part(template, criterion.status === 'met' ? 'status-met' : 'status-not-met'),
              justification: criterion.justification.trim(),
            }),
          )
          .join('\n');
  return part(template, 'report', {
    summary: submitted.summary.trim(),
    criteria,
    tests: files(template, submitted.tests),
    docs: files(template, submitted.docs),
    adrs:
      submitted.adrs.length === 0
        ? part(template, 'no-adrs')
        : submitted.adrs
            .map((path) => part(template, 'path', { path }))
            .join(part(template, 'path-separator')),
  });
}

/**
 * The first message of a review run, within `maxBytes`: when it does not fit, the oldest comments
 * go first (the message says how many), then the report is cut at a line boundary with a marker
 * pointing to `ticket_get`, then the description, as for an `implement` run (03, section 3.2).
 */
export function reviewFirstMessage(
  template: Template,
  ticket: ReviewTicket,
  maxBytes = FIRST_MESSAGE_MAX_BYTES,
): string {
  const criteria =
    ticket.acceptanceCriteria.length === 0
      ? part(template, 'no-criteria')
      : ticket.acceptanceCriteria
          .map((text, index) => part(template, 'criterion', { number: String(index + 1), text }))
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
  const renderedReviews = ticket.earlierReviews.map((review) =>
    part(template, 'earlier-review', {
      author: author(template, review.author),
      at: timestamp(review.at),
      body: review.body.trim(),
    }),
  );
  const renderedComments = ticket.comments.map((comment) =>
    part(template, 'comment', {
      author: author(template, comment.author),
      kind: comment.kind,
      at: timestamp(comment.at),
      body: comment.body.trim(),
    }),
  );
  const ci = ciSection(template, ticket);
  const previousPieces =
    ticket.previous === null ? null : previous(template, ticket, ticket.previous);
  // The owner's request was written after the criteria and wins where they disagree, so a
  // criterion it superseded is no reason to request changes (owner's answer 14, lot 4 step C).
  const ownerFirst =
    ticket.previous?.by === 'owner' ? `${part(template, 'owner-request-first')}\n\n` : '';
  const testsRule = part(template, ticket.ci === 'no_ci' ? 'tests-no-ci' : 'tests-ci-passed');

  /** The newest `kept` of `items`, after the marker saying how many older ones are left out. */
  const newest = (items: string[], kept: number, marker: string, none: string) => {
    if (items.length === 0) return part(template, none);
    const leftOut = items.length - kept;
    return [
      ...(leftOut > 0 ? [part(template, marker, { count: String(leftOut) })] : []),
      ...items.slice(leftOut),
    ].join('\n\n');
  };

  interface Cut {
    comments: number;
    reviews: number;
    notes: number;
    report: string;
    /** Quality's points shown, or the owner's request's lines. */
    items: number;
    description: string;
  }
  const render = (cut: Cut) =>
    `${fill(template, template.main, {
      ticket: ticket.reference,
      project_name: ticket.projectName,
      commit: ticket.commit,
      pull_request: String(ticket.pullRequest.number),
      pull_request_url: ticket.pullRequest.url,
      base: ticket.base,
      ci,
      title: ticket.title,
      type: ticket.type,
      priority: ticket.priority,
      description: cut.description,
      acceptance_criteria: criteria,
      owner_request_first: ownerFirst,
      dependencies,
      report: cut.report,
      earlier_reviews: newest(
        renderedReviews,
        cut.reviews,
        'earlier-reviews-left-out',
        'no-earlier-reviews',
      ),
      previous_review:
        previousPieces === null ? '' : `${previousPieces.render(cut.items, cut.notes)}\n\n`,
      comments: newest(renderedComments, cut.comments, 'comments-left-out', 'no-comments'),
      tests_rule: testsRule,
    })}\n`;
  const fits = (text: string) => bytes(text) <= maxBytes;
  /** The largest count from `least` to `most` for which `ok` holds, `ok` holding for smaller ones. */
  const largest = (least: number, most: number, ok: (count: number) => boolean) => {
    let low = least;
    let high = most;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (ok(middle)) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  /** The first `count` lines of `text`, then `marker`. */
  const cutLines = (lines: string[], count: number, marker: string) =>
    [lines.slice(0, count).join('\n').trimEnd(), marker].filter((t) => t !== '').join('\n\n');

  const description = ticket.description.trim();
  const descriptionLines = description.split('\n');
  const reportLines = report(template, ticket).split('\n');
  const items = previousPieces?.items.length ?? 0;
  const owner = ticket.previous?.by === 'owner';
  let cut: Cut = {
    comments: renderedComments.length,
    reviews: renderedReviews.length,
    notes: previousPieces?.notes.length ?? 0,
    report: reportLines.join('\n'),
    items,
    description: description === '' ? part(template, 'empty-description') : description,
  };
  if (fits(render(cut))) return render(cut);

  // Each step only while the message is still too long (03, section 3.2; owner's answer 1, lot 3
  // step I2): the oldest comments, the oldest earlier reviews, the oldest notes, the report, the
  // last points down to the second (the owner's request by lines), the description, the first point.
  type Step = (fitting: (change: Partial<Cut>) => boolean) => Partial<Cut>;
  const steps: Step[] = [
    (ok) => ({ comments: largest(0, cut.comments, (count) => ok({ comments: count })) }),
    (ok) => ({ reviews: largest(0, cut.reviews, (count) => ok({ reviews: count })) }),
    (ok) => ({ notes: largest(0, cut.notes, (count) => ok({ notes: count })) }),
    (ok) => {
      const marker = part(template, 'report-cut');
      const kept = largest(0, reportLines.length - 1, (count) =>
        ok({ report: cutLines(reportLines, count, marker) }),
      );
      return { report: cutLines(reportLines, kept, marker) };
    },
    (ok) => {
      const least = owner ? 0 : Math.min(1, items);
      return {
        items: largest(least, Math.max(least, items - (owner ? 1 : 0)), (count) =>
          ok({ items: count }),
        ),
      };
    },
    (ok) => {
      const marker = part(template, 'description-cut');
      const kept = largest(0, descriptionLines.length - 1, (count) =>
        ok({ description: cutLines(descriptionLines, count, marker) }),
      );
      return { description: cutLines(descriptionLines, kept, marker) };
    },
    () => ({ items: 0 }),
  ];
  for (const step of steps) {
    const current = cut;
    cut = { ...current, ...step((change) => fits(render({ ...current, ...change }))) };
    if (fits(render(cut))) return render(cut);
  }
  throw new FirstMessageTooLarge(ticket.reference);
}
