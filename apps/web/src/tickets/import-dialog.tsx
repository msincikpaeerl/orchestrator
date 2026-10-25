import {
  TicketImportPreview,
  TicketImportResponse,
  type Project,
  type TicketImportBlocker,
  type TicketImportProblem,
  type TicketImportPreviewTicket,
} from '@orchestrator/protocol';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, ApiRequestError } from '../api';
import {
  Button,
  ErrorMessage,
  HelpLink,
  InfoMessage,
  TextArea,
  WarningMessage,
} from '../components/ui';
import { ticketsChanged } from '../queries';
import { refusalText } from '../refusals';
import {
  assigneeLabel,
  priorityLabel,
  statusLabel,
  ticketPath,
  ticketRef,
  typeLabel,
} from './text';

/** Where a problem is, in the owner's words: "Ticket 2 “contact”, field title". */
export function problemPlace(problem: TicketImportProblem): string {
  const ticket =
    problem.position === null
      ? 'The file'
      : `Ticket ${String(problem.position)}${problem.key === null ? '' : ` “${problem.key}”`}`;
  return problem.field === null ? ticket : `${ticket}, field ${problem.field}`;
}

function blockerText(projectKey: string, blocker: TicketImportBlocker): string {
  return blocker.kind === 'file'
    ? `“${blocker.key}” (${blocker.title})`
    : `${ticketRef(projectKey, blocker.number)} (${blocker.title}, ${statusLabel[blocker.status].toLowerCase()})`;
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? '' : 's'}`;
}

function PreviewTicket({
  projectKey,
  ticket,
}: {
  projectKey: string;
  ticket: TicketImportPreviewTicket;
}) {
  return (
    <li className="rounded border border-slate-200 p-3">
      <p className="font-medium break-words text-slate-900">
        {ticket.key} · {ticket.title}
      </p>
      <p className="text-sm text-slate-700">
        {typeLabel[ticket.type]} · {priorityLabel[ticket.priority]} priority ·{' '}
        {assigneeLabel(ticket.assignee)} ·{' '}
        {ticket.criteria === 1
          ? '1 acceptance criterion'
          : `${String(ticket.criteria)} acceptance criteria`}
      </p>
      {ticket.blockedBy.length > 0 && (
        <p className="text-sm break-words text-slate-700">
          Waits for {ticket.blockedBy.map((each) => blockerText(projectKey, each)).join(', ')}
        </p>
      )}
    </li>
  );
}

function Problems({ problems }: { problems: TicketImportProblem[] }) {
  return (
    <div role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-red-800">
      <p className="font-medium">
        {problems.length === 1
          ? '1 problem to correct'
          : `${String(problems.length)} problems to correct`}{' '}
        before importing:
      </p>
      <ul aria-label="Problems" className="mt-1 list-disc space-y-1 pl-5">
        {problems.map((problem, index) => (
          <li key={index} className="break-words">
            <strong>{problemPlace(problem)}</strong>: {problem.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * **Import tickets** (02, section 6.3; lot 5bis step A): pasted text or a .json file in the
 * format of 06 section 4.6, previewed (nothing written), then imported all at once, or not at all.
 */
export function ImportTicketsDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const fileId = useId();
  const [text, setText] = useState('');
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      dialog?.close();
    };
  }, []);

  const path = `/api/projects/${project.key}/tickets/import`;
  const preview = useMutation({
    mutationFn: (body: string) =>
      api('POST', `${path}/preview`, TicketImportPreview, { text: body }),
  });
  const save = useMutation({
    mutationFn: (body: string) => api('POST', path, TicketImportResponse, { text: body }),
    onSuccess: async () => {
      await ticketsChanged();
    },
  });

  function edit(next: string) {
    setText(next);
    preview.reset();
    save.reset();
  }

  async function chooseFile(file: File | undefined) {
    setFileProblem(null);
    if (!file) return;
    try {
      edit(await file.text());
    } catch {
      setFileProblem('This file could not be read. Choose it again, or paste its text below.');
    }
  }

  const tooLarge = (error: unknown) => error instanceof ApiRequestError && error.status === 413;
  const errorText = (error: unknown) =>
    tooLarge(error)
      ? 'The file is too large to import at once. Split it into smaller files.'
      : refusalText(error);
  // After a refused import, its problems replace the preview's.
  const refusedProblems =
    save.error instanceof ApiRequestError ? (save.error.importProblems ?? null) : null;
  const shown = preview.data;
  const problems = refusedProblems ?? shown?.problems ?? [];
  const canImport = shown !== undefined && problems.length === 0 && shown.tickets.length > 0;
  const created = save.data?.tickets;

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="m-auto max-h-[calc(100%-2rem)] w-[calc(100%-2rem)] max-w-3xl overflow-y-auto rounded-lg bg-white p-4 shadow-xl backdrop:bg-slate-900/50 sm:p-6"
    >
      <h2 id={titleId} className="text-lg font-semibold text-slate-900">
        Import tickets
      </h2>
      {created ? (
        <div className="mt-3 space-y-3 text-slate-700">
          <InfoMessage>
            {plural(created.length, 'ticket')} imported in To do on {project.key}.
          </InfoMessage>
          <ul aria-label="Imported tickets" className="space-y-1">
            {created.map((ticket) => (
              <li key={ticket.number} className="break-words">
                <Link
                  to={ticketPath(project.key, ticket.number)}
                  className="text-blue-700 underline"
                  onClick={onClose}
                >
                  {ticketRef(project.key, ticket.number)} · {ticket.title}
                </Link>
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <Button onClick={onClose}>Close</Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-4 text-slate-700">
          <p>
            Paste the text of a ticket file, or choose a .json file. <strong>Preview</strong> checks
            it and creates nothing; <strong>Import</strong> then creates every ticket in To do, or
            none if anything is wrong.{' '}
            <HelpLink page="import-tickets" newTab>
              How to write the file
            </HelpLink>
          </p>
          <div>
            <label htmlFor={fileId} className="block font-medium text-slate-800">
              Choose a .json file
            </label>
            <input
              id={fileId}
              type="file"
              accept=".json,application/json"
              className="mt-1 block w-full text-sm"
              onChange={(event) => {
                void chooseFile(event.target.files?.[0]);
              }}
            />
            {fileProblem && <ErrorMessage>{fileProblem}</ErrorMessage>}
          </div>
          <TextArea
            label="Text of the file"
            rows={10}
            spellCheck={false}
            className="mt-1 block w-full rounded border border-slate-300 bg-white px-3 py-2 font-mono text-sm"
            value={text}
            onChange={(event) => {
              edit(event.target.value);
            }}
          />
          {preview.isError && <ErrorMessage>{errorText(preview.error)}</ErrorMessage>}
          {save.isError && <ErrorMessage>{errorText(save.error)}</ErrorMessage>}
          {problems.length > 0 && <Problems problems={problems} />}
          {shown?.warnings.map((warning) => (
            <WarningMessage key={warning}>{warning}</WarningMessage>
          ))}
          {shown && shown.tickets.length > 0 && (
            <section aria-labelledby={`${titleId}-tickets`} className="space-y-2">
              <h3 id={`${titleId}-tickets`} className="font-semibold text-slate-900">
                {problems.length === 0
                  ? `${plural(shown.tickets.length, 'ticket')} to create, numbered in this order`
                  : `${plural(shown.tickets.length, 'ticket')} in the file`}
              </h3>
              <ol aria-label="Tickets to create" className="space-y-2">
                {shown.tickets.map((ticket) => (
                  <PreviewTicket key={ticket.position} projectKey={project.key} ticket={ticket} />
                ))}
              </ol>
            </section>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button
              variant={canImport ? 'secondary' : 'primary'}
              disabled={preview.isPending || save.isPending}
              onClick={() => {
                save.reset();
                preview.mutate(text);
              }}
            >
              Preview
            </Button>
            {canImport && (
              <Button
                disabled={save.isPending}
                onClick={() => {
                  save.mutate(text);
                }}
              >
                Import {plural(shown.tickets.length, 'ticket')}
              </Button>
            )}
          </div>
        </div>
      )}
    </dialog>
  );
}
