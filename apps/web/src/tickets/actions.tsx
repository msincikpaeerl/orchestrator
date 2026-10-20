import {
  MarkDoneRequest,
  PullRequestReopenResponse,
  RejectRequest,
  RequestChangesRequest,
  Run,
  TicketDetail,
} from '@orchestrator/protocol';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api';
import { Button, ConfirmDialog, ErrorMessage, TextArea, WarningMessage } from '../components/ui';
import { ticketsChanged } from '../queries';
import { refusalText } from '../refusals';
import { runPath } from '../runs/text';
import {
  RUN_NOW_AFTER_TRY_AGAIN,
  contradictingCriterionText,
  holdBoxText,
  requestChangesText,
} from './change-text';
import { markDoneWarning, ticketRef } from './text';

// The owner's actions on a ticket (04, section 2), the same on the ticket page and on "Needs you"
// (02, sections 4 and 6.4).

/** Which ticket an action applies to. */
export interface TicketAddress {
  projectKey: string;
  number: number;
}

export function ticketApi(ticket: TicketAddress, action = ''): string {
  return `/api/projects/${encodeURIComponent(ticket.projectKey)}/tickets/${String(ticket.number)}${action}`;
}

/** A ticket action; the screens are read again after it, or after a refusal of it. */
function useTicketAction<T>(request: (input: T) => Promise<TicketDetail>) {
  return useMutation({
    mutationFn: request,
    onSuccess: (changed) => ticketsChanged(changed),
    onError: () => ticketsChanged(),
  });
}

/** **Cancel**, after a confirmation saying what happens (02, section 1). */
export function CancelAction({ ticket }: { ticket: TicketDetail }) {
  const [asking, setAsking] = useState(false);
  const cancel = useTicketAction(() => api('POST', ticketApi(ticket, '/cancel'), TicketDetail));
  const ref = ticketRef(ticket.projectKey, ticket.number);
  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          cancel.reset();
          setAsking(true);
        }}
      >
        Cancel the ticket
      </Button>
      {asking && (
        <ConfirmDialog
          title={`Cancel ${ref}?`}
          confirmLabel="Cancel the ticket"
          dismissLabel="Keep it"
          busy={cancel.isPending}
          error={cancel.error && <ErrorMessage>{refusalText(cancel.error)}</ErrorMessage>}
          onConfirm={() => {
            cancel.mutate(undefined, {
              onSuccess: () => {
                setAsking(false);
              },
            });
          }}
          onCancel={() => {
            setAsking(false);
          }}
        >
          <p>
            The ticket is kept with its history, and no work will be done on it. You can reopen it
            later.
          </p>
          {ticket.blocks.length > 0 && (
            <p>
              Tickets waiting for it stay blocked: remove their dependency on {ref}, or reopen it.
            </p>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}

/** **Mark as done manually**: the comment explaining why is mandatory (04, section 2). */
export function MarkDoneAction({ ticket }: { ticket: TicketDetail }) {
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState('');
  const [missing, setMissing] = useState(false);
  const markDone = useTicketAction((body: MarkDoneRequest) =>
    api('POST', ticketApi(ticket, '/mark-done'), TicketDetail, body),
  );
  const ref = ticketRef(ticket.projectKey, ticket.number);
  const warning = markDoneWarning(ticket.projectKey, ticket.number, ticket.blockedBy);
  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          markDone.reset();
          setMissing(false);
          setAsking(true);
        }}
      >
        Mark as done manually
      </Button>
      {asking && (
        <ConfirmDialog
          title={`Mark ${ref} as done?`}
          confirmLabel={warning ? 'Mark as done anyway' : 'Mark as done'}
          busy={markDone.isPending}
          error={markDone.error && <ErrorMessage>{refusalText(markDone.error)}</ErrorMessage>}
          onConfirm={() => {
            if (comment.trim() === '') {
              setMissing(true);
              return;
            }
            markDone.mutate(
              { comment: comment.trim() },
              {
                onSuccess: () => {
                  setAsking(false);
                  setComment('');
                },
              },
            );
          }}
          onCancel={() => {
            setAsking(false);
          }}
        >
          <p>
            Use this when the result exists because the work was done another way. The ticket goes
            to Done, and tickets waiting for it are no longer blocked by it. If the work is
            abandoned, cancel the ticket instead.
          </p>
          {warning && <WarningMessage>{warning}</WarningMessage>}
          <TextArea
            label="Why is it done? (required)"
            hint="Added to the ticket's timeline."
            value={comment}
            error={missing ? 'Write why the ticket is done: this comment is required.' : undefined}
            onChange={(event) => {
              setComment(event.target.value);
              setMissing(false);
            }}
          />
        </ConfirmDialog>
      )}
    </>
  );
}

export function ReopenAction({ ticket }: { ticket: TicketAddress }) {
  const reopen = useTicketAction(() => api('POST', ticketApi(ticket, '/reopen'), TicketDetail));
  return (
    <>
      <Button
        onClick={() => {
          reopen.mutate();
        }}
        disabled={reopen.isPending}
      >
        Reopen
      </Button>
      {reopen.error && <ErrorMessage>{refusalText(reopen.error)}</ErrorMessage>}
    </>
  );
}

/**
 * **Run now** (07, section 3): the run starts at once on a machine chosen for it, and the run
 * page opens; when it cannot start, the reason is shown (02, section 6.4).
 */
export function RunNowAction({ ticket }: { ticket: TicketAddress }) {
  const runNow = useRunNow(ticket);
  return (
    <>
      <Button
        onClick={() => {
          runNow.mutate();
        }}
        disabled={runNow.isPending}
      >
        Run now
      </Button>
      {runNow.error && (
        <div className="w-full">
          <ErrorMessage>{refusalText(runNow.error)}</ErrorMessage>
        </div>
      )}
    </>
  );
}

function useRunNow(ticket: TicketAddress) {
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => api('POST', ticketApi(ticket, '/run'), Run),
    onSettled: () => ticketsChanged(),
    onSuccess: (run) => navigate(runPath(run.id)),
  });
}

/**
 * **Start review** (04, section 3.2; lot 3 step H): a review run by Quality, one Claude Code
 * session, with no confirmation, as **Run now** (owner's answer 5); the run page opens. A refusal
 * says why and what to do.
 */
export function StartReviewAction({ ticket }: { ticket: TicketAddress }) {
  const navigate = useNavigate();
  const start = useMutation({
    mutationFn: () => api('POST', ticketApi(ticket, '/review'), Run),
    onSettled: () => ticketsChanged(),
    onSuccess: (run) => navigate(runPath(run.id)),
  });
  return (
    <>
      <Button
        onClick={() => {
          start.mutate();
        }}
        disabled={start.isPending}
      >
        Start review
      </Button>
      {start.error && (
        <div className="w-full">
          <ErrorMessage>{refusalText(start.error)}</ErrorMessage>
        </div>
      )}
    </>
  );
}

/**
 * **Skip review** (04, section 2; owner's answer 5, lot 3 step H): the ticket moves to Awaiting
 * merge without Quality's review, after a confirmation; no session.
 */
export function SkipReviewAction({ ticket }: { ticket: TicketAddress }) {
  const [asking, setAsking] = useState(false);
  const skip = useTicketAction(() => api('POST', ticketApi(ticket, '/skip-review'), TicketDetail));
  const ref = ticketRef(ticket.projectKey, ticket.number);
  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          skip.reset();
          setAsking(true);
        }}
      >
        Skip review
      </Button>
      {asking && (
        <ConfirmDialog
          title={`Skip the review of ${ref}?`}
          confirmLabel="Skip review"
          dismissLabel="Keep it in review"
          busy={skip.isPending}
          error={skip.error && <ErrorMessage>{refusalText(skip.error)}</ErrorMessage>}
          onConfirm={() => {
            skip.mutate(undefined, {
              onSuccess: () => {
                setAsking(false);
              },
            });
          }}
          onCancel={() => {
            setAsking(false);
          }}
        >
          <p>
            It moves to Awaiting merge without Quality&apos;s review: check the pull request
            yourself before merging it on GitHub.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}

/** **Accept** a ticket an agent proposed: it goes to To do (04, section 2). */
export function AcceptAction({ ticket }: { ticket: TicketAddress }) {
  const accept = useTicketAction(() => api('POST', ticketApi(ticket, '/accept'), TicketDetail));
  return (
    <>
      <Button
        onClick={() => {
          accept.mutate();
        }}
        disabled={accept.isPending}
      >
        Accept
      </Button>
      {accept.error && (
        <div className="w-full">
          <ErrorMessage>{refusalText(accept.error)}</ErrorMessage>
        </div>
      )}
    </>
  );
}

/** **Reject** a ticket an agent proposed, with an optional comment: it is cancelled. */
export function RejectAction({ ticket }: { ticket: TicketAddress }) {
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState('');
  const reject = useTicketAction((body: RejectRequest) =>
    api('POST', ticketApi(ticket, '/reject'), TicketDetail, body),
  );
  const ref = ticketRef(ticket.projectKey, ticket.number);
  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          reject.reset();
          setAsking(true);
        }}
      >
        Reject
      </Button>
      {asking && (
        <ConfirmDialog
          title={`Reject ${ref}?`}
          confirmLabel="Reject"
          dismissLabel="Keep it"
          busy={reject.isPending}
          error={reject.error && <ErrorMessage>{refusalText(reject.error)}</ErrorMessage>}
          onConfirm={() => {
            reject.mutate(comment.trim() === '' ? {} : { comment: comment.trim() }, {
              onSuccess: () => {
                setAsking(false);
                setComment('');
              },
            });
          }}
          onCancel={() => {
            setAsking(false);
          }}
        >
          <p>The ticket is cancelled and kept with its history. You can reopen it later.</p>
          <TextArea
            label="Why? (optional)"
            hint="Added to the ticket's timeline."
            value={comment}
            onChange={(event) => {
              setComment(event.target.value);
            }}
          />
        </ConfirmDialog>
      )}
    </>
  );
}

/**
 * **Request changes** on finished work (`in_review` with no review run active, and `awaiting_merge`
 * from lot 3 step I; 04 section 2): the comment saying what to change is mandatory, and the ticket
 * goes back to To do. The ticket then leaves the state this
 * button is shown in, so the page shows `RunNowOffer` itself once `onRequested` is called.
 */
export function RequestChangesAction({
  ticket,
  onRequested,
  text = requestChangesText('in_review', null),
  filledIn = '',
}: {
  ticket: TicketAddress;
  /** `held`: the hold box was checked, so no **Run now** is offered (owner's new answer 2). */
  onRequested: (held: boolean) => void;
  /** What happens, from `requestChangesText`: on Awaiting merge it names the approval or skip. */
  text?: string;
  /**
   * The comment the dialog opens with, which the owner may edit: on a conflict, the text the API
   * gives (owner's answer 4 of step J). The server marks a conflict from GitHub's stored fact,
   * never from this text.
   */
  filledIn?: string;
}) {
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState('');
  const [hold, setHold] = useState(false);
  const [missing, setMissing] = useState(false);
  // `onRequested` is called before the screens are read again: the ticket then leaves
  // `in_review` and this button, with any callback given to `mutate`, is gone.
  const request = useMutation({
    mutationFn: (body: RequestChangesRequest) =>
      api('POST', ticketApi(ticket, '/request-changes'), TicketDetail, body),
    onSuccess: (changed, body) => {
      onRequested(body.hold === true);
      return ticketsChanged(changed);
    },
    onError: () => ticketsChanged(),
  });
  const ref = ticketRef(ticket.projectKey, ticket.number);
  const holdBox = holdBoxText(ref);
  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          request.reset();
          setMissing(false);
          if (comment === '') setComment(filledIn);
          setAsking(true);
        }}
      >
        Request changes
      </Button>
      {asking && (
        <ConfirmDialog
          title={`Request changes on ${ref}?`}
          confirmLabel="Request changes"
          dismissLabel="Keep it"
          busy={request.isPending}
          error={request.error && <ErrorMessage>{refusalText(request.error)}</ErrorMessage>}
          onConfirm={() => {
            if (comment.trim() === '') {
              setMissing(true);
              return;
            }
            request.mutate(
              { comment: comment.trim(), hold },
              {
                onSuccess: () => {
                  setAsking(false);
                  setComment('');
                  setHold(false);
                },
              },
            );
          }}
          onCancel={() => {
            setAsking(false);
          }}
        >
          <p>{text}</p>
          <p>{contradictingCriterionText(ref)}</p>
          <TextArea
            label="What should change? (required)"
            hint="Added to the ticket's timeline; the agent reads it."
            value={comment}
            error={missing ? 'Write what should change: this comment is required.' : undefined}
            onChange={(event) => {
              setComment(event.target.value);
              setMissing(false);
            }}
          />
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={hold}
              onChange={(event) => {
                setHold(event.target.checked);
              }}
            />
            <span>
              {holdBox.label}
              <span className="block text-sm text-slate-600">{holdBox.hint}</span>
            </span>
          </label>
        </ConfirmDialog>
      )}
    </>
  );
}

/**
 * **Reopen pull request** on a pull request closed on GitHub without merging (lot 3 step J3a): one
 * attempt, answered once made. A refusal is kept on the ticket and shown by the item.
 */
export function ReopenPullRequestAction({ ticket }: { ticket: TicketAddress }) {
  const reopen = useMutation({
    mutationFn: () =>
      api('POST', ticketApi(ticket, '/pull-request/reopen'), PullRequestReopenResponse),
    onSettled: () => ticketsChanged(),
  });
  return (
    <>
      <Button
        onClick={() => {
          reopen.mutate();
        }}
        disabled={reopen.isPending}
      >
        {reopen.isPending ? 'Reopening…' : 'Reopen pull request'}
      </Button>
      {reopen.error && (
        <div className="w-full">
          <ErrorMessage>{refusalText(reopen.error)}</ErrorMessage>
        </div>
      )}
    </>
  );
}

/**
 * After **Request changes**: **Run now** offered directly, the usual action with its usual
 * refusals (owner's decision, lot 2 step L2).
 */
export function RunNowOffer({
  ticket,
  onClose,
  after = 'request_changes',
}: {
  ticket: TicketAddress;
  onClose: () => void;
  /** What succeeded: **Request changes**, or **Try again** (owner's answer 3, lot 3 step I2). */
  after?: 'request_changes' | 'try_again';
}) {
  const runNow = useRunNow(ticket);
  const ref = ticketRef(ticket.projectKey, ticket.number);
  return (
    <ConfirmDialog
      title={after === 'try_again' ? `${ref} can continue` : `Changes requested on ${ref}`}
      confirmLabel="Run now"
      dismissLabel="Later"
      busy={runNow.isPending}
      error={runNow.error && <ErrorMessage>{refusalText(runNow.error)}</ErrorMessage>}
      onConfirm={() => {
        runNow.mutate();
      }}
      onCancel={onClose}
    >
      <p>
        {after === 'try_again'
          ? RUN_NOW_AFTER_TRY_AGAIN
          : 'The ticket is back in To do. Start the next run now, or later from the ticket page.'}
      </p>
    </ConfirmDialog>
  );
}

/**
 * **Try again** on a ticket stopped by the retry policy (04, section 5; owner's answers 2 and 3,
 * lot 3 step I2): no confirmation, since it starts no session; once it succeeds, `onTried` lets
 * the screen offer **Run now** (`RunNowOffer` with `after="try_again"`). It is called before the
 * screens are read again, since the stop and this button are then gone.
 */
export function TryAgainAction({
  ticket,
  onTried,
}: {
  ticket: TicketAddress;
  onTried: () => void;
}) {
  const tryAgain = useMutation({
    mutationFn: () => api('POST', ticketApi(ticket, '/try-again'), TicketDetail),
    onSuccess: (changed) => {
      onTried();
      return ticketsChanged(changed);
    },
    onError: () => ticketsChanged(),
  });
  return (
    <>
      <Button
        onClick={() => {
          tryAgain.mutate();
        }}
        disabled={tryAgain.isPending}
      >
        Try again
      </Button>
      {tryAgain.error && (
        <div className="w-full">
          <ErrorMessage>{refusalText(tryAgain.error)}</ErrorMessage>
        </div>
      )}
    </>
  );
}
