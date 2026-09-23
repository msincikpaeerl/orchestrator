import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Link } from 'react-router';

/**
 * Link to a Help page, or to a section of it with `page#section`. `newTab` keeps a half-filled
 * form open (wizard, login).
 */
export function HelpLink({
  page,
  children = 'Help',
  newTab = false,
}: {
  page: string;
  children?: ReactNode;
  newTab?: boolean;
}) {
  const to = page === 'index' ? '/help' : `/help/${page}`;
  return (
    <Link
      to={to}
      className="text-sm text-blue-700 underline"
      {...(newTab ? { target: '_blank', rel: 'noopener' } : {})}
    >
      {children}
    </Link>
  );
}

export function PageHeader({ title, help }: { title: string; help: string }) {
  return (
    <div className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
      <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
      <HelpLink page={help} />
    </div>
  );
}

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' }) {
  const look =
    variant === 'primary'
      ? 'bg-blue-700 text-white hover:bg-blue-800'
      : 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50';
  return (
    <button
      type="button"
      className={`rounded px-4 py-2 font-medium disabled:opacity-50 ${look} ${className}`}
      {...props}
    />
  );
}

/** Style shared by buttons rendered as links. */
export const buttonLinkClass =
  'inline-block rounded bg-blue-700 px-4 py-2 font-medium text-white hover:bg-blue-800';

/** Ids and `aria-describedby` of a field's hint and error, shown under its label. */
function useFieldIds(hint: ReactNode, error: ReactNode) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ');
  return { id, describedBy: describedBy || undefined };
}

function FieldLabel({
  id,
  label,
  hint,
  error,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
}) {
  return (
    <>
      <label htmlFor={id} className="block font-medium text-slate-800">
        {label}
      </label>
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-slate-600">
          {hint}
        </p>
      )}
      {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </>
  );
}

/** A refusal about one field, shown next to it. */
export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="mt-1 text-sm font-medium text-red-700">
      {children}
    </p>
  );
}

const inputClass =
  'mt-1 block w-full rounded border border-slate-300 bg-white px-3 py-2 disabled:bg-slate-100 aria-invalid:border-red-500';

export function TextField({
  label,
  hint,
  error,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
}) {
  const { id, describedBy } = useFieldIds(hint, error);
  return (
    <div>
      <FieldLabel id={id} label={label} hint={hint} error={error} />
      <input
        id={id}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className={inputClass}
        {...props}
      />
    </div>
  );
}

export function TextArea({
  label,
  hint,
  error,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
}) {
  const { id, describedBy } = useFieldIds(hint, error);
  return (
    <div>
      <FieldLabel id={id} label={label} hint={hint} error={error} />
      <textarea
        id={id}
        rows={3}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className={inputClass}
        {...props}
      />
    </div>
  );
}

export function SelectField({
  label,
  hint,
  error,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
}) {
  const { id, describedBy } = useFieldIds(hint, error);
  return (
    <div>
      <FieldLabel id={id} label={label} hint={hint} error={error} />
      <select
        id={id}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className={inputClass}
        {...props}
      >
        {children}
      </select>
    </div>
  );
}

/** Information that is not a problem, for example "Branch protection not available". */
export function InfoMessage({ children }: { children: ReactNode }) {
  return (
    <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-slate-800">
      {children}
    </div>
  );
}

/**
 * Asks before an action (02, section 1). Shown as a modal dialog; Escape or **Cancel** closes it.
 * `error` shows a refusal of the action inside the dialog.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy: boolean;
  error?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      dialog?.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-lg bg-white p-4 shadow-xl backdrop:bg-slate-900/50 sm:p-6"
    >
      <h2 id={titleId} className="text-lg font-semibold text-slate-900">
        {title}
      </h2>
      <div className="mt-3 space-y-2 text-slate-700">{children}</div>
      {error && <div className="mt-3">{error}</div>}
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={onConfirm} disabled={busy}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}

export function ErrorMessage({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-red-800">
      {children}
    </p>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-slate-200 bg-white p-4 sm:p-6 ${className}`}>
      {children}
    </div>
  );
}

/** Full-page layout of the screens shown before logging in: wizard and login. */
export function CenteredPage({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-xl px-4 py-8 sm:py-12">
      <p className="mb-6 text-lg font-semibold text-slate-900">Orchestrator</p>
      {children}
    </main>
  );
}

export function Loading() {
  return <p className="p-4 text-slate-600">Loading…</p>;
}
