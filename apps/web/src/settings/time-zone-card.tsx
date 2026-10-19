import { SaveTimeZoneRequest, TimeZoneResponse } from '@orchestrator/protocol';
import { useMutation } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { api } from '../api';
import { Button, Card, ErrorMessage, SelectField } from '../components/ui';
import { keys, queryClient, useTimeZone } from '../queries';
import { refusalText } from '../refusals';

/** The browser's time zone, the suggestion before the owner's first save. */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Every time zone the browser knows, UTC first. */
function timeZoneChoices(current: string): string[] {
  const known = Intl.supportedValuesOf('timeZone');
  return ['UTC', ...new Set([current, ...known].filter((zone) => zone !== 'UTC'))].sort((a, b) =>
    a === 'UTC' ? -1 : b === 'UTC' ? 1 : a.localeCompare(b),
  );
}

/**
 * Settings > Time zone (02, section 10; owner's answer 6, lot 4 step A): filled in from the
 * browser until the owner saves one; the accounts' windows, daily budget and "today" read it.
 */
export function TimeZoneCard() {
  const saved = useTimeZone();
  const [chosen, setChosen] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (timeZone: string) =>
      api('PUT', '/api/time-zone', TimeZoneResponse, SaveTimeZoneRequest.parse({ timeZone })),
    onSuccess: async (result) => {
      queryClient.setQueryData(keys.timeZone, result);
      setChosen(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.accounts }),
        queryClient.invalidateQueries({ queryKey: keys.needsYou }),
      ]);
    },
  });
  if (!saved.data) {
    return (
      <Card>
        <h2 className="font-semibold text-slate-900">Time zone</h2>
        {saved.isError && <ErrorMessage>The time zone could not be loaded.</ErrorMessage>}
      </Card>
    );
  }
  const value = chosen ?? (saved.data.saved ? saved.data.timeZone : browserTimeZone());
  const unchanged = saved.data.saved && value === saved.data.timeZone;

  function submit(event: SubmitEvent) {
    event.preventDefault();
    save.mutate(value);
  }

  return (
    <Card>
      <form className="space-y-3" onSubmit={submit} aria-label="Time zone">
        <h2 className="font-semibold text-slate-900">Time zone</h2>
        <p className="text-slate-700">
          The Claude accounts' schedule windows, the day of their daily budget and "runs today" are
          read in this time zone, summer and winter time included.
        </p>
        <p className="text-slate-900">
          {saved.data.saved
            ? `Saved: ${saved.data.timeZone}.`
            : 'Not saved yet: until you save one, the Orchestrator uses UTC. Your browser’s time zone is filled in below.'}
        </p>
        <SelectField
          label="Time zone"
          value={value}
          onChange={(event) => {
            setChosen(event.target.value);
            save.reset();
          }}
        >
          {timeZoneChoices(value).map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </SelectField>
        {save.error && <ErrorMessage>{refusalText(save.error)}</ErrorMessage>}
        <Button type="submit" disabled={save.isPending || unchanged}>
          Save the time zone
        </Button>
      </form>
    </Card>
  );
}
