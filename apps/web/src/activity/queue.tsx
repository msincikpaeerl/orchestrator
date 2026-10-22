import { Run, type QueueCandidate } from '@orchestrator/protocol';
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { api } from '../api';
import { Button, Card, ErrorMessage, Loading } from '../components/ui';
import { PauseButton } from '../machines/account-parts';
import { ticketsChanged, useQueue } from '../queries';
import { refusalText } from '../refusals';
import { runPath } from '../runs/text';
import { RunNowAction, StartReviewAction } from '../tickets/actions';
import { ticketPath, ticketRef } from '../tickets/text';
import {
  accountLineText,
  candidateFactsText,
  candidateReasonText,
  candidateStartOffered,
} from './queue-text';

/** **Resume** of a paused run from its line: the run page opens; a refusal says why. */
function ResumeAction({ runId }: { runId: string }) {
  const navigate = useNavigate();
  const resume = useMutation({
    mutationFn: () => api('POST', `/api/runs/${encodeURIComponent(runId)}/resume`, Run),
    onSettled: () => ticketsChanged(),
    onSuccess: (run) => navigate(runPath(run.id)),
  });
  return (
    <>
      <Button
        onClick={() => {
          resume.mutate();
        }}
        disabled={resume.isPending}
      >
        Resume
      </Button>
      {resume.error && (
        <div className="w-full">
          <ErrorMessage>{refusalText(resume.error)}</ErrorMessage>
        </div>
      )}
    </>
  );
}

/**
 * The owner's start from a line (02, section 7): **Run now** for work to do, **Start review** for
 * a review, **Resume** for a paused run; each with its own checks and refusals. Offered only where
 * it can start the line (`candidateStartOffered`).
 */
function CandidateAction({ candidate }: { candidate: QueueCandidate }) {
  const ticket = { projectKey: candidate.ticket.projectKey, number: candidate.ticket.number };
  if (candidate.kind === 'resume' && candidate.runId !== null) {
    return <ResumeAction runId={candidate.runId} />;
  }
  if (candidate.kind === 'review') return <StartReviewAction ticket={ticket} />;
  return <RunNowAction ticket={ticket} />;
}

function CandidateItem({ candidate, place }: { candidate: QueueCandidate; place: number }) {
  const { ticket } = candidate;
  return (
    <li className="space-y-1 border-b border-slate-200 py-3 last:border-b-0">
      <p className="font-medium break-words text-slate-900">
        <span className="text-slate-600">{place}.</span>{' '}
        <Link to={ticketPath(ticket.projectKey, ticket.number)} className="text-blue-700 underline">
          {ticketRef(ticket.projectKey, ticket.number)} · {ticket.title}
        </Link>
      </p>
      <p className="text-sm break-words text-slate-600">{candidateFactsText(candidate)}</p>
      <p className="break-words text-slate-800" aria-label="Why it is not running">
        {candidateReasonText(candidate)}
      </p>
      {candidateStartOffered(candidate) && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <CandidateAction candidate={candidate} />
        </div>
      )}
    </li>
  );
}

/**
 * Activity > Queue (02, section 7; 07, section 7; lot 4 step H): each Claude account's line, then
 * each candidate in the scheduler's order with why it is not running, live. Reading it starts
 * nothing.
 */
export function Queue() {
  const queue = useQueue();
  return (
    <section aria-labelledby="queue-title" className="space-y-4">
      <h2 id="queue-title" className="text-xl font-semibold text-slate-900">
        Queue
      </h2>
      <p className="text-slate-700">
        What the scheduler starts next, in its order, and why each one waits. This list follows
        every change by itself; looking at it starts nothing.
      </p>
      {queue.isPending ? (
        <Loading />
      ) : queue.isError ? (
        <ErrorMessage>{refusalText(queue.error)}</ErrorMessage>
      ) : (
        <>
          {queue.data.accounts.length > 0 && (
            <Card>
              <ul aria-label="Claude accounts in the queue" className="space-y-3">
                {queue.data.accounts.map((line) => {
                  const text = accountLineText(line);
                  return (
                    <li
                      key={line.account.id}
                      className="flex flex-wrap items-start justify-between gap-2"
                    >
                      <div className="min-w-0 space-y-1 break-words">
                        <p className="font-medium text-slate-900">{text.title}</p>
                        <p className="text-sm text-slate-600">{text.today}</p>
                        {text.unavailable && <p className="text-slate-800">{text.unavailable}</p>}
                      </div>
                      <PauseButton account={{ ...line.account, state: line.status.state }} />
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
          {queue.data.candidates.length === 0 ? (
            <Card>
              <p>
                Nothing is waiting: no ticket in To do or In review, and no paused run, for the
                scheduler to start.
              </p>
            </Card>
          ) : (
            <Card>
              <ol aria-label="Queue">
                {queue.data.candidates.map((candidate, index) => (
                  <CandidateItem
                    key={`${candidate.kind}-${candidate.runId ?? ''}-${candidate.ticket.projectKey}-${String(candidate.ticket.number)}`}
                    candidate={candidate}
                    place={index + 1}
                  />
                ))}
              </ol>
            </Card>
          )}
        </>
      )}
    </section>
  );
}
