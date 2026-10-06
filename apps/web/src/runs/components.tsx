import {
  Run,
  TicketDetail,
  type AccountStatus,
  type AnswerRequest,
  type Comment,
  type CommitSummary,
  type RunLogEntry,
} from '@orchestrator/protocol';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState, type SubmitEvent } from 'react';
import { api } from '../api';
import { UntrustedMarkdown } from '../components/markdown';
import { Button, ConfirmDialog, ErrorMessage, HelpLink, TextArea } from '../components/ui';
import { formatDateTime } from '../github/text';
import { ticketsChanged } from '../queries';
import { refusalText } from '../refusals';
import {
  accountStatusText,
  durationText,
  isActive,
  logKindLabel,
  logTime,
  openQuestion,
  pausedText,
  runTimes,
  shortHash,
} from './text';

/** The current time, every second while `ticking`: an active run's times grow on screen. */
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [ticking]);
  return now;
}

/**
 * A Claude account's state in plain words (02, sections 4 and 9.1): a limit whose time has passed
 * is shown available at once, without waiting for the server.
 */
export function AccountStatusText({
  account,
}: {
  account: Pick<AccountStatus, 'state' | 'limitedUntil' | 'limitedUntilEstimated'>;
}) {
  const now = useNow(account.state === 'limited');
  const passed =
    account.state === 'limited' &&
    account.limitedUntil !== null &&
    new Date(account.limitedUntil).getTime() <= now;
  return <>{accountStatusText(passed ? { ...account, state: 'available' } : account)}</>;
}

/** "Working 12 min · waiting 3 min" (01, section 3.7). */
export function RunTimes({ run }: { run: Run }) {
  const now = useNow(isActive(run.status));
  const { workingMs, waitingMs } = runTimes(run, now);
  return (
    <>
      working {durationText(workingMs)} · waiting {durationText(waitingMs)}
    </>
  );
}

/** Commits of a branch, newest first: short hash and subject. */
export function CommitList({
  commits,
  label = 'Commits',
}: {
  commits: CommitSummary[];
  label?: string;
}) {
  if (commits.length === 0) return <p className="text-slate-700">No commits yet.</p>;
  return (
    <ul aria-label={label} className="space-y-1">
      {commits.map((commit) => (
        <li key={commit.hash} className="break-words">
          <code className="rounded bg-slate-100 px-1 text-sm">{shortHash(commit.hash)}</code>{' '}
          {commit.subject}
        </li>
      ))}
    </ul>
  );
}

/**
 * **Stop run** and **Resume** (04, section 2), each shown when it applies. Stop run asks first,
 * saying what happens to the ticket and the branch.
 */
export function RunActions({ run }: { run: Run }) {
  const [asking, setAsking] = useState(false);
  const stop = useMutation({
    mutationFn: () => api('POST', `/api/runs/${run.id}/stop`, Run),
    onSettled: () => ticketsChanged(),
  });
  const resume = useMutation({
    mutationFn: () => api('POST', `/api/runs/${run.id}/resume`, Run),
    onSettled: () => ticketsChanged(),
  });
  // A detected limit: Resume becomes possible by itself once the limit time has passed.
  const now = useNow(run.status === 'paused_quota' && run.resumeAfter !== null);
  const waiting = run.resumeAfter !== null && now < new Date(run.resumeAfter.at).getTime();
  if (!isActive(run.status)) return null;
  return (
    <div className="space-y-2">
      {run.status === 'paused_quota' && (
        <p className="text-slate-800">
          {pausedText(waiting ? run : { ...run, resumeAfter: null })}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {run.status === 'paused_quota' && (
          <Button
            disabled={resume.isPending || waiting}
            onClick={() => {
              stop.reset();
              resume.mutate();
            }}
          >
            Resume
          </Button>
        )}
        <Button
          variant="secondary"
          onClick={() => {
            resume.reset();
            stop.reset();
            setAsking(true);
          }}
        >
          Stop run
        </Button>
      </div>
      {resume.error && <ErrorMessage>{refusalText(resume.error)}</ErrorMessage>}
      {asking && (
        <ConfirmDialog
          title="Stop this run?"
          confirmLabel="Stop run"
          dismissLabel="Let it run"
          busy={stop.isPending}
          error={stop.error && <ErrorMessage>{refusalText(stop.error)}</ErrorMessage>}
          onConfirm={() => {
            stop.mutate(undefined, {
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
            The agent stops now and the ticket goes back to To do. The branch and its commits stay
            on machine {run.machine.name}, and the next run continues from them. A stopped run does
            not count as a failed attempt.
          </p>
          {!run.machine.online && (
            <p>
              Machine {run.machine.name} is offline: the run is marked as failed because of that,
              and its session is stopped when the machine reconnects.
            </p>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}

/**
 * The agent's open question and the answer box (04, section 6), the same on the ticket page, the
 * run page and "Needs you" (02, section 4). Nothing is shown without an open question.
 */
export function AnswerBox({ ticket }: { ticket: TicketDetail }) {
  const question = openQuestion(ticket);
  if (!question) return null;
  return <QuestionAnswer ticket={ticket} question={question} />;
}

/** The answer box for one open question of a ticket. */
export function QuestionAnswer({
  ticket,
  question,
}: {
  ticket: { projectKey: string; number: number };
  question: Comment;
}) {
  const [body, setBody] = useState('');
  const [missing, setMissing] = useState(false);
  const answer = useMutation({
    mutationFn: (input: AnswerRequest) =>
      api(
        'POST',
        `/api/projects/${encodeURIComponent(ticket.projectKey)}/tickets/${String(ticket.number)}/answer`,
        TicketDetail,
        input,
      ),
    onSuccess: (changed) => ticketsChanged(changed),
    onError: () => ticketsChanged(),
  });

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (body.trim() === '') {
      setMissing(true);
      return;
    }
    answer.mutate(
      { body: body.trim() },
      {
        onSuccess: () => {
          setBody('');
        },
      },
    );
  }

  return (
    <section
      aria-label="Question from the agent"
      className="space-y-3 rounded-lg border-2 border-amber-300 bg-amber-50 p-4"
    >
      <h2 className="text-lg font-semibold text-slate-900">
        Question from {question.agent ? `agent ${question.agent.profile.name}` : 'the agent'}
      </h2>
      <p className="text-sm text-slate-600">{formatDateTime(question.createdAt)}</p>
      <UntrustedMarkdown>{question.body}</UntrustedMarkdown>
      <form className="space-y-2" onSubmit={submit} noValidate>
        <TextArea
          label="Your answer"
          hint="The agent receives it at once and goes on. Markdown is allowed."
          rows={4}
          value={body}
          error={missing ? 'Write your answer first.' : undefined}
          onChange={(event) => {
            setBody(event.target.value);
            setMissing(false);
            answer.reset();
          }}
        />
        {answer.error && <ErrorMessage>{refusalText(answer.error)}</ErrorMessage>}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={answer.isPending}>
            Send answer
          </Button>
          <HelpLink page="runs#questions">About questions</HelpLink>
        </div>
      </form>
    </section>
  );
}

/** One entry of a run's log: what it is, when, and its text as written (never as Markdown). */
export function LogEntry({ entry }: { entry: RunLogEntry }) {
  const look =
    entry.kind === 'warning'
      ? 'border-amber-400 bg-amber-50'
      : entry.kind === 'input'
        ? 'border-blue-300 bg-blue-50'
        : entry.kind === 'agent_text'
          ? 'border-slate-400 bg-white'
          : 'border-slate-200 bg-slate-50';
  return (
    <li className={`min-w-0 border-l-4 px-3 py-2 ${look}`}>
      <p className="text-sm text-slate-600">
        {logKindLabel[entry.kind]}
        {entry.tool && ` · ${entry.tool}`} · {logTime(entry.at)}
      </p>
      <p className="font-mono text-sm break-words whitespace-pre-wrap text-slate-900">
        {entry.text}
      </p>
    </li>
  );
}
