import {
  FIRST_MESSAGE_MAX_BYTES,
  type DodReport,
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
} from './messages.js';

// The first message of a `review` run (03, section 3.1; owner's answers 4 and 5, lot 3 step H):
// the commit under review, CI, the ticket, the agent's report, earlier reviews and comments, from
// the template `review`. Like an `implement` run's, within `FIRST_MESSAGE_MAX_BYTES`.

/** What the review is told about CI: never that it failed or did not finish (answer 4). */
export type ReviewCi = 'passed' | 'passed_later' | 'no_ci';

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
  /** The ticket's `review` comments, oldest first. */
  earlierReviews: readonly Omit<FirstMessageComment, 'kind'>[];
  /** The commit under review, fixed at **Start review**. */
  commit: string;
  pullRequest: { number: number; url: string };
  base: string;
  ci: ReviewCi;
  /** The ticket's workflow flag: `changed`, `not_listed` (may have changed), or none. */
  workflows: 'changed' | 'not_listed' | null;
  /** The accepted submission's report. */
  report: DodReport;
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
              index: String(criterion.index),
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
  const earlierReviews =
    ticket.earlierReviews.length === 0
      ? part(template, 'no-earlier-reviews')
      : ticket.earlierReviews
          .map((review) =>
            part(template, 'earlier-review', {
              author: author(template, review.author),
              at: timestamp(review.at),
              body: review.body.trim(),
            }),
          )
          .join('\n\n');
  const renderedComments = ticket.comments.map((comment) =>
    part(template, 'comment', {
      author: author(template, comment.author),
      kind: comment.kind,
      at: timestamp(comment.at),
      body: comment.body.trim(),
    }),
  );
  const ci = ciSection(template, ticket);
  const testsRule = part(template, ticket.ci === 'no_ci' ? 'tests-no-ci' : 'tests-ci-passed');

  const render = (kept: number, reportText: string, description: string) => {
    const leftOut = renderedComments.length - kept;
    const comments =
      renderedComments.length === 0
        ? part(template, 'no-comments')
        : [
            ...(leftOut > 0
              ? [part(template, 'comments-left-out', { count: String(leftOut) })]
              : []),
            ...renderedComments.slice(leftOut),
          ].join('\n\n');
    return `${fill(template, template.main, {
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
      description,
      acceptance_criteria: criteria,
      dependencies,
      report: reportText,
      earlier_reviews: earlierReviews,
      comments,
      tests_rule: testsRule,
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
  /** The first `count` lines of `text`, then `marker`. */
  const cutLines = (lines: string[], count: number, marker: string) =>
    [lines.slice(0, count).join('\n').trimEnd(), marker].filter((t) => t !== '').join('\n\n');

  const description = ticket.description.trim();
  const fullDescription = description === '' ? part(template, 'empty-description') : description;
  const fullReport = report(template, ticket);
  const all = renderedComments.length;
  if (fits(render(all, fullReport, fullDescription)))
    return render(all, fullReport, fullDescription);

  const kept = largest(all - 1, (count) => fits(render(count, fullReport, fullDescription)));
  if (fits(render(kept, fullReport, fullDescription))) {
    return render(kept, fullReport, fullDescription);
  }

  const reportLines = fullReport.split('\n');
  const reportCut = part(template, 'report-cut');
  const reportKept = largest(reportLines.length - 1, (count) =>
    fits(render(0, cutLines(reportLines, count, reportCut), fullDescription)),
  );
  const shortReport = cutLines(reportLines, reportKept, reportCut);
  if (fits(render(0, shortReport, fullDescription))) {
    return render(0, shortReport, fullDescription);
  }

  const descriptionLines = description.split('\n');
  const descriptionCut = part(template, 'description-cut');
  const descriptionKept = largest(descriptionLines.length - 1, (count) =>
    fits(render(0, reportCut, cutLines(descriptionLines, count, descriptionCut))),
  );
  const result = render(0, reportCut, cutLines(descriptionLines, descriptionKept, descriptionCut));
  if (!fits(result)) throw new FirstMessageTooLarge(ticket.reference);
  return result;
}
