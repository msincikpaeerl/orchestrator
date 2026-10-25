import {
  GITHUB_TOKEN_LIST_URL,
  type AutomaticMergeView,
  type TicketDetail,
} from '@orchestrator/protocol';
import { Link } from 'react-router';
import { ReopenPullRequestAction } from './actions';
import {
  automaticMergeText,
  closeWantedText,
  closedStateText,
  conflictFlagText,
  headMovedText,
  mergedElsewhereText,
  reopenFailureText,
  watchFailureText,
} from './merge-text';
import { ticketRef } from './text';

// What GitHub said of the ticket's pull request, as "Needs you" and the ticket page show it (02,
// sections 4 and 6.4; owner's answers 1, 3 and 4 of step J, lot 3 steps J4a and J4b): the same
// words in both places.

export const warningClass =
  'rounded border border-amber-300 bg-amber-50 p-2 break-words text-slate-800';

/** The automatic merge's line (lot 5 step 5bis B), with the token list for a missing permission. */
export function AutomaticMergeLine({ view }: { view: AutomaticMergeView }) {
  const line = automaticMergeText(view);
  if (line === null) return null;
  return (
    <div
      aria-label="Automatic merge"
      className={line.warning ? `${warningClass} space-y-1` : 'break-words text-slate-700'}
    >
      <p>{line.text}</p>
      {line.tokens && (
        <a
          href={GITHUB_TOKEN_LIST_URL}
          target="_blank"
          rel="noreferrer"
          className="text-blue-700 underline"
        >
          Open your tokens on GitHub
        </a>
      )}
    </div>
  );
}

/** The moved head: the sentence, then the commits added or the approved commit no longer part. */
export function HeadMovedLines({
  moved,
  pullRequest,
}: {
  moved: NonNullable<TicketDetail['pullRequest']['headMoved']>;
  pullRequest: number;
}) {
  const text = headMovedText(moved, pullRequest);
  return (
    <div aria-label="Head moved" className={`${warningClass} space-y-1`}>
      <p>{text.sentence}</p>
      {text.added.length > 0 && (
        <>
          <p>Commits added since, newest first:</p>
          <ul className="list-disc pl-5">
            {text.added.map((title, index) => (
              <li key={`${String(index)} ${title}`} className="break-words">
                {title}
              </li>
            ))}
            {text.more && <li>{text.more}</li>}
          </ul>
        </>
      )}
      {text.notPart && <p>{text.notPart}</p>}
    </div>
  );
}

/** Whether the ticket page shows any line of what GitHub said of the pull request since. */
export function showsGitHubLines(pullRequest: TicketDetail['pullRequest']): boolean {
  const { opened, closed, close, conflict, headMoved, watchFailure, merged } = pullRequest;
  return (
    opened !== null &&
    ([closed, close, conflict, headMoved, watchFailure].some((fact) => fact !== null) ||
      merged?.intoDefaultBranch === false)
  );
}

/**
 * The ticket page's lines on the pull request as GitHub has it (lot 3 step J4b): closed (on GitHub
 * or at **Cancel**) with **Reopen pull request** and a refused reopen, **Cancel**'s close not done
 * yet, the conflict, the moved head and the watch's failure. **Request changes** for a conflict is
 * the page's own action, filled in from the API.
 */
export function PullRequestGitHubLines({
  ticket,
  canChange,
}: {
  ticket: TicketDetail;
  canChange: boolean;
}) {
  const { opened, closed, close, reopenFailure, watchFailure, conflict, headMoved, merged } =
    ticket.pullRequest;
  if (!opened) return null;
  const ref = ticketRef(ticket.projectKey, ticket.number);
  const goesOn = ticket.status !== 'done' && ticket.status !== 'cancelled';
  const closeText = close && closeWantedText(close, opened.number, ref);
  return (
    <>
      {closed && opened.state === 'closed' && (
        <div aria-label="Closed" className="space-y-2">
          <p className="break-words text-slate-700">
            {closedStateText(closed, opened.number, ref, ticket.status)}
          </p>
          {reopenFailure && (
            <p aria-label="Reopen refused" className={warningClass}>
              {reopenFailureText(ref, reopenFailure)}
            </p>
          )}
          {canChange && goesOn && closed.by === 'github' && (
            <div className="flex flex-wrap items-start gap-2">
              <ReopenPullRequestAction ticket={ticket} />
            </div>
          )}
        </div>
      )}
      {merged && !merged.intoDefaultBranch && opened.state === 'merged' && (
        <p aria-label="Merged elsewhere" className="break-words text-slate-700">
          {mergedElsewhereText(merged, opened.number, ticket.status)}
        </p>
      )}
      {closeText && (
        <div
          aria-label="Close"
          className={close.failure === null ? 'text-slate-700' : `${warningClass} space-y-1`}
        >
          <p className="break-words">{closeText.sentence}</p>
          {closeText.where === 'tokens' && (
            <a
              href={GITHUB_TOKEN_LIST_URL}
              target="_blank"
              rel="noreferrer"
              className="text-blue-700 underline"
            >
              Open your tokens on GitHub
            </a>
          )}
          {closeText.where === 'settings' && (
            <Link to="/settings/github" className="text-blue-700 underline">
              Open GitHub connection
            </Link>
          )}
        </div>
      )}
      {conflict && (
        <p aria-label="Conflict" className={warningClass}>
          {conflictFlagText(conflict.base)}
          {ticket.status === 'awaiting_merge' &&
            ` Request changes comes with a comment asking the agent to merge ${conflict.base} and resolve the conflicts.`}
        </p>
      )}
      {headMoved && <HeadMovedLines moved={headMoved} pullRequest={opened.number} />}
      {watchFailure && (
        <p aria-label="Not checked on GitHub" className={warningClass}>
          {watchFailureText(watchFailure)}
        </p>
      )}
    </>
  );
}
