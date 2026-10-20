import {
  GITHUB_TOKEN_LIST_URL,
  type ReviewDecision,
  type ReviewPostView,
  type RunDetail,
  type TicketDetail,
} from '@orchestrator/protocol';
import { Link } from 'react-router';
import { UntrustedMarkdown } from '../components/markdown';
import { Card, HelpLink } from '../components/ui';
import { useGlobalSettings } from '../queries';
import { runPath } from '../runs/text';
import { SkipReviewAction, StartReviewAction } from './actions';
import { requestedAfterText } from './change-text';
import { reviewPostText } from './review-post-text';
import {
  REVIEW_COST,
  awaitingMergeText,
  reviewStartText,
  pointText,
  runReviewText,
  ticketReviewText,
} from './review-text';

// Quality's review on the ticket page and the run page (02, sections 6.4 and 7; owner's answers
// 2 to 5, lot 3 steps H and H4). Quality's summary and points are agent text: plain text, never
// HTML (ADR 0024).

/** The summary of an approval, or the points of a request for changes. */
function DecisionDetails({ decision }: { decision: ReviewDecision }) {
  if (decision.kind === 'approved') {
    return decision.summary === null ? null : (
      <section aria-label="Quality's summary" className="text-slate-800">
        <UntrustedMarkdown>{decision.summary}</UntrustedMarkdown>
      </section>
    );
  }
  return (
    <ol aria-label="Points to address" className="list-decimal space-y-1 pl-6 text-slate-800">
      {decision.points.map((point, index) => (
        <li key={index} className="break-words whitespace-pre-wrap">
          {pointText(point)}
        </li>
      ))}
    </ol>
  );
}

/** "Posted on GitHub" (a link), "Posting on GitHub…", or the note when it is not known there. */
function PostLine({ post, commit }: { post: ReviewPostView; commit: string }) {
  if (post.state === 'posting') {
    return (
      <p role="status" className="text-slate-700">
        Posting on GitHub…
      </p>
    );
  }
  const note = reviewPostText(post, commit);
  if (note.posted && note.url !== null) {
    return (
      <p aria-label="Review on GitHub">
        <a href={note.url} target="_blank" rel="noreferrer" className="text-blue-700 underline">
          {note.text}
        </a>
      </p>
    );
  }
  return (
    <div
      aria-label="Review on GitHub"
      className="space-y-1 rounded border border-amber-300 bg-amber-50 p-3"
    >
      <p className="break-words text-slate-800">{note.text}</p>
      {note.where === 'tokens' && (
        <a
          href={GITHUB_TOKEN_LIST_URL}
          target="_blank"
          rel="noreferrer"
          className="text-blue-700 underline"
        >
          Open your tokens on GitHub
        </a>
      )}
      {note.where === 'settings' && (
        <Link to="/settings/github" className="text-blue-700 underline">
          Open GitHub connection
        </Link>
      )}
    </div>
  );
}

function Warning({ text }: { text: string }) {
  return (
    <p className="rounded border border-amber-300 bg-amber-50 p-3 break-words text-slate-800">
      {text}
    </p>
  );
}

/**
 * The ticket page's review section: the latest review (or skip), whether it is about an earlier
 * submission, **Start review** and **Skip review** when offered, and the Awaiting merge line.
 */
export function TicketReviewSection({
  ticket,
  canChange,
}: {
  ticket: TicketDetail;
  canChange: boolean;
}) {
  const { review } = ticket;
  const text = ticketReviewText(review);
  const opened = ticket.pullRequest.opened;
  const awaitingMerge = ticket.status === 'awaiting_merge' && opened !== null;
  const offered = review.offered && canChange;
  // The check interval's value, for the Awaiting merge line (owner's answer 7, lot 3 step J1).
  const settings = useGlobalSettings();
  const interval =
    settings.data?.settings.find((setting) => setting.name === 'githubPollSeconds')?.value ?? null;
  if (text === null && !offered && !awaitingMerge) return null;
  const { latest } = review;
  // While the owner's request on Awaiting merge stands (owner's answer 6, lot 3 step I).
  const requestedAfter =
    latest?.kind === 'decision' || latest?.kind === 'skipped'
      ? requestedAfterText(ticket.changeRequest)
      : null;
  return (
    <Card className="space-y-3">
      <h2 className="text-lg font-semibold text-slate-900">Review</h2>
      <section aria-label="Latest review" className="space-y-2">
        {text === null ? (
          review.offered && <p className="text-slate-700">Not reviewed yet.</p>
        ) : (
          <p className="font-medium break-words text-slate-900">{text.heading}</p>
        )}
        {text?.earlier && <p className="break-words text-slate-700">{text.earlier}</p>}
        {requestedAfter && (
          <p className="font-medium break-words text-slate-900">{requestedAfter}</p>
        )}
        {latest?.kind === 'decision' && <DecisionDetails decision={latest.decision} />}
        {latest?.kind === 'decision' && latest.post && (
          <PostLine post={latest.post} commit={latest.decision.commit} />
        )}
        {text?.headNotChecked && <Warning text={text.headNotChecked} />}
        {latest !== null && latest.kind !== 'skipped' && (
          <Link to={runPath(latest.runId)} className="inline-block text-blue-700 underline">
            Open the review run
          </Link>
        )}
      </section>
      {awaitingMerge && (
        <p aria-label="Merge" className="break-words text-slate-900">
          {awaitingMergeText(opened.number, interval)}
        </p>
      )}
      {offered && (
        <>
          <p className="text-slate-700">{REVIEW_COST}</p>
          {review.start && (
            <p aria-label="When the review starts" className="break-words text-slate-700">
              {reviewStartText[review.start]}
            </p>
          )}
          <div className="flex flex-wrap items-start gap-2">
            <StartReviewAction ticket={ticket} />
            <SkipReviewAction ticket={ticket} />
          </div>
        </>
      )}
      <p className="text-sm text-slate-600">
        <HelpLink page="tickets#review-by-quality">Review by Quality</HelpLink>
      </p>
    </Card>
  );
}

/** The run page's review card (02, section 7): the commit, the decision, why not applied, post. */
export function RunReviewCard({ run }: { run: RunDetail }) {
  const { review } = run;
  if (review === null) return null;
  const text = runReviewText(review, run);
  return (
    <Card className="space-y-2">
      <h2 className="text-lg font-semibold text-slate-900">Review</h2>
      <section aria-label="Review card" className="space-y-2">
        {text.reviewed && <p className="break-words text-slate-900">{text.reviewed}</p>}
        <p className="font-medium text-slate-900">{text.decision}</p>
        {review.decision && <DecisionDetails decision={review.decision} />}
        {text.notApplied && <Warning text={text.notApplied} />}
        {review.decision && review.post && (
          <PostLine post={review.post} commit={review.decision.commit} />
        )}
        {text.headNotChecked && <Warning text={text.headNotChecked} />}
      </section>
    </Card>
  );
}
