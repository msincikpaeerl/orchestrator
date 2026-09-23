import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router';

/** Link to a Help page. `newTab` keeps a half-filled form open (wizard, login). */
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

export function TextField({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block font-medium text-slate-800">
        {label}
      </label>
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-slate-600">
          {hint}
        </p>
      )}
      <input
        id={id}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 disabled:bg-slate-100"
        {...props}
      />
    </div>
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
