import { SETTINGS, type SettingName } from '@orchestrator/protocol';
import { useId, useState, type ReactNode, type SubmitEvent } from 'react';
import { Button, ErrorMessage, TextField } from '../components/ui';
import { refusalText } from '../refusals';
import { laterText, parseTyped } from './text';

/**
 * One setting with its value, **Save** and **Reset to default**: a section named after the
 * setting, so each one can be found by its name.
 */
export function SettingEditor({
  name,
  value,
  canReset,
  details,
  disabled = false,
  busy,
  saved,
  error,
  onSave,
  onReset,
}: {
  name: SettingName;
  /** The value in use, shown in the field. */
  value: number;
  /** A value is stored: **Reset to default** removes it. */
  canReset: boolean;
  /** Where the value comes from (the default, the global value, an override). */
  details: ReactNode;
  disabled?: boolean;
  busy: boolean;
  saved: boolean;
  error: unknown;
  onSave: (value: number) => void;
  onReset: () => void;
}) {
  const definition = SETTINGS[name];
  const headingId = useId();
  const [typed, setTyped] = useState(String(value));
  const [shown, setShown] = useState(value);
  const [touched, setTouched] = useState(false);
  // A new value from the server (saved, reset, or changed elsewhere) replaces the typed one.
  if (shown !== value) {
    setShown(value);
    setTyped(String(value));
    setTouched(false);
  }
  const parsed = parseTyped(name, typed);
  const later = laterText(name);

  function submit(event: SubmitEvent) {
    event.preventDefault();
    setTouched(true);
    if (parsed.value !== null) onSave(parsed.value);
  }

  return (
    <section aria-labelledby={headingId} className="space-y-2 py-4 first:pt-0 last:pb-0">
      <h3 id={headingId} className="font-semibold text-slate-900">
        {definition.label}
      </h3>
      <p className="text-slate-700">{definition.description}</p>
      {later && <p className="text-sm text-slate-600">{later}</p>}
      <div className="text-sm text-slate-600">{details}</div>
      <form className="flex flex-wrap items-end gap-2" onSubmit={submit} noValidate>
        <div className="w-full sm:w-56">
          <TextField
            label={`Value (${definition.unit})`}
            inputMode="numeric"
            value={typed}
            disabled={disabled}
            error={touched ? parsed.error : null}
            onChange={(event) => {
              setTyped(event.target.value);
            }}
          />
        </div>
        {!disabled && (
          <>
            <Button type="submit" disabled={busy}>
              Save
            </Button>
            <Button variant="secondary" disabled={busy || !canReset} onClick={onReset}>
              Reset to default
            </Button>
          </>
        )}
      </form>
      {error !== null && error !== undefined && <ErrorMessage>{refusalText(error)}</ErrorMessage>}
      {saved && (
        <p role="status" className="text-green-800">
          Saved.
        </p>
      )}
    </section>
  );
}
