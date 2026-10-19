import {
  ClaudeAccount,
  DAILY_BUDGET,
  SCHEDULE_WINDOWS_MAX,
  Weekday,
  type DailyBudget,
  type Schedule,
  type ScheduleWindow,
} from '@orchestrator/protocol';
import { useMutation } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { api } from '../api';
import { Button, ErrorMessage, FieldError, TextField } from '../components/ui';
import { machinesChanged, queryClient } from '../queries';
import { refusalText } from '../refusals';
import {
  budgetUsedText,
  dayLabel,
  pausedText,
  todayText,
  windowPositionText,
  withoutEstimateText,
} from './schedule-text';

// The parts of a Claude account's screens (02, sections 4 and 9.1; lot 4 step C).

async function accountChanged() {
  await Promise.all([machinesChanged(), queryClient.invalidateQueries({ queryKey: ['accounts'] })]);
}

/** **Stop new runs** or **Resume** (07, section 5.5): no confirmation, neither starts a session. */
export function PauseButton({
  account,
}: {
  account: Pick<ClaudeAccount, 'id' | 'label' | 'state'>;
}) {
  const paused = account.state === 'paused_manual';
  const change = useMutation({
    mutationFn: () =>
      api(
        'POST',
        `/api/accounts/${account.id}/${paused ? 'resume' : 'stop-new-runs'}`,
        ClaudeAccount,
      ),
    onSuccess: accountChanged,
  });
  return (
    <>
      <Button
        variant="secondary"
        className="shrink-0"
        aria-label={`${paused ? 'Resume' : 'Stop new runs on'} ${account.label}`}
        disabled={change.isPending}
        onClick={() => {
          change.mutate();
        }}
      >
        {paused ? 'Resume' : 'Stop new runs'}
      </Button>
      {change.error && <ErrorMessage>{refusalText(change.error)}</ErrorMessage>}
    </>
  );
}

/** Paused, the window, today against the budget, and the budget used (07, section 7). */
export function AccountDayLines({ account }: { account: ClaudeAccount }) {
  const position = windowPositionText(account.today.window);
  const withoutEstimate = withoutEstimateText(account.today.usage.runsWithoutEstimate);
  return (
    <>
      {account.state === 'paused_manual' && <p className="text-slate-900">{pausedText()}</p>}
      {position && <p className="text-slate-700">{position}</p>}
      <p className="text-slate-700">{todayText(account.today, account.dailyBudget)}</p>
      {account.today.budgetUsed && (
        <p className="font-medium text-amber-900">{budgetUsedText(account.today)}</p>
      )}
      {withoutEstimate && <p className="text-sm text-slate-600">{withoutEstimate}</p>}
    </>
  );
}

/** An end at 00:00 is the midnight closing the day: sent as 24:00 (01, section 3.9). */
const toEnd = (time: string) => (time === '00:00' ? '24:00' : time);
const fromEnd = (time: string) => (time === '24:00' ? '00:00' : time);

interface WindowDraft {
  key: number;
  days: Weekday[];
  start: string;
  end: string;
}

let nextKey = 0;
const draft = (window: ScheduleWindow): WindowDraft => ({
  key: (nextKey += 1),
  days: [...window.days],
  start: window.start,
  end: fromEnd(window.end),
});

/** The account's weekly windows, edited and saved together (07, section 5.3). */
export function ScheduleEditor({
  account,
  timeZone,
}: {
  account: ClaudeAccount;
  timeZone: string;
}) {
  const [windows, setWindows] = useState<WindowDraft[]>(() => account.schedule.map(draft));
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: (schedule: Schedule) =>
      api('PATCH', `/api/accounts/${account.id}`, ClaudeAccount, { schedule }),
    onSuccess: async () => {
      setSaved(true);
      await accountChanged();
    },
  });
  const edit = (key: number, change: Partial<WindowDraft>) => {
    setSaved(false);
    save.reset();
    setWindows((current) =>
      current.map((window) => (window.key === key ? { ...window, ...change } : window)),
    );
  };

  const [checked, setChecked] = useState(false);
  const problem = (window: WindowDraft): string | null => {
    if (window.days.length === 0) return 'Choose at least one day.';
    if (window.start === '' || window.end === '') return 'Enter both times.';
    if (window.start === window.end && window.start !== '00:00') {
      return 'The start and the end must differ.';
    }
    return null;
  };

  function submit(event: SubmitEvent) {
    event.preventDefault();
    setChecked(true);
    if (windows.some((window) => problem(window) !== null)) return;
    save.mutate(
      windows.map((window) => ({
        days: Weekday.options.filter((day) => window.days.includes(day)),
        start: window.start,
        end: toEnd(window.end),
      })),
    );
  }

  return (
    <form className="space-y-4" onSubmit={submit} aria-label="Schedule windows" noValidate>
      <p className="text-slate-700">
        Runs start only inside these windows; with none, at any time. They are read in the time zone{' '}
        {timeZone}. A window ending at 00:00 ends at midnight; one ending before its start ends the
        next day. When a window ends, a run already started finishes.
      </p>
      {windows.length === 0 && (
        <p className="text-slate-900">No window: runs may start at any time.</p>
      )}
      <ul className="space-y-4" aria-label="Windows">
        {windows.map((window, index) => (
          <li key={window.key} className="space-y-3 rounded border border-slate-200 p-3">
            <fieldset>
              <legend className="font-medium text-slate-800">Window {index + 1}: days</legend>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-2">
                {Weekday.options.map((day) => (
                  <label key={day} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={window.days.includes(day)}
                      onChange={(event) => {
                        edit(window.key, {
                          days: event.target.checked
                            ? [...window.days, day]
                            : window.days.filter((other) => other !== day),
                        });
                      }}
                    />
                    {dayLabel[day]}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label={`Window ${String(index + 1)}: from`}
                type="time"
                value={window.start}
                onChange={(event) => {
                  edit(window.key, { start: event.target.value });
                }}
              />
              <TextField
                label={`Window ${String(index + 1)}: until`}
                type="time"
                value={window.end}
                onChange={(event) => {
                  edit(window.key, { end: event.target.value });
                }}
              />
            </div>
            {checked && problem(window) !== null && <FieldError>{problem(window)}</FieldError>}
            <Button
              variant="secondary"
              onClick={() => {
                setSaved(false);
                setWindows((current) => current.filter((other) => other.key !== window.key));
              }}
            >
              Remove window {index + 1}
            </Button>
          </li>
        ))}
      </ul>
      {save.error && <ErrorMessage>{refusalText(save.error)}</ErrorMessage>}
      {saved && <p className="text-green-800">Windows saved.</p>}
      <div className="flex flex-wrap gap-2">
        {windows.length < SCHEDULE_WINDOWS_MAX && (
          <Button
            variant="secondary"
            onClick={() => {
              setSaved(false);
              setWindows((current) => [
                ...current,
                draft({
                  days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
                  start: '00:00',
                  end: '08:00',
                }),
              ]);
            }}
          >
            Add a window
          </Button>
        )}
        <Button type="submit" disabled={save.isPending}>
          Save windows
        </Button>
      </div>
    </form>
  );
}

type BudgetKind = 'none' | 'working_time' | 'estimated_usage';

/** The account's daily budget: none, working time or estimated usage (07, section 5.4). */
export function BudgetEditor({ account, timeZone }: { account: ClaudeAccount; timeZone: string }) {
  const current = account.dailyBudget;
  const [kind, setKind] = useState<BudgetKind>(current?.kind ?? 'none');
  const [minutes, setMinutes] = useState(
    current?.kind === 'working_time' ? String(current.minutes) : '60',
  );
  const [usd, setUsd] = useState(
    current?.kind === 'estimated_usage' ? current.usd.toFixed(2) : '5.00',
  );
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: (dailyBudget: DailyBudget) =>
      api('PATCH', `/api/accounts/${account.id}`, ClaudeAccount, { dailyBudget }),
    onSuccess: async () => {
      setSaved(true);
      await accountChanged();
    },
  });
  const changed = () => {
    setSaved(false);
    save.reset();
  };

  const [checked, setChecked] = useState(false);
  const minutesValue = Number(minutes);
  const usdValue = Number(usd);
  const minutesError =
    kind === 'working_time' &&
    !(
      Number.isInteger(minutesValue) &&
      minutesValue >= DAILY_BUDGET.minutes.min &&
      minutesValue <= DAILY_BUDGET.minutes.max
    )
      ? 'Enter a whole number of minutes from 1 to 1,440.'
      : null;
  const usdError =
    kind === 'estimated_usage' &&
    !(
      usd.trim() !== '' &&
      usdValue >= DAILY_BUDGET.usd.min &&
      usdValue <= DAILY_BUDGET.usd.max &&
      Math.abs(usdValue * 100 - Math.round(usdValue * 100)) < 1e-6
    )
      ? 'Enter an amount in dollars and cents from 0.01 to 10,000, for example 5.00.'
      : null;

  function submit(event: SubmitEvent) {
    event.preventDefault();
    setChecked(true);
    if (minutesError || usdError) return;
    save.mutate(
      kind === 'none'
        ? null
        : kind === 'working_time'
          ? { kind, minutes: minutesValue }
          : { kind, usd: Math.round(usdValue * 100) / 100 },
    );
  }

  const choices: { value: BudgetKind; label: string }[] = [
    { value: 'none', label: 'No daily budget' },
    { value: 'working_time', label: 'Working time' },
    { value: 'estimated_usage', label: 'Estimated usage' },
  ];
  return (
    <form className="space-y-4" onSubmit={submit} aria-label="Daily budget" noValidate>
      <p className="text-slate-700">
        Once the runs started today reach it, no new run starts on this account until midnight in
        the time zone {timeZone}; a run already started finishes, and Run now still starts one.
        Working time counts only the time agents work, not the time they wait. Estimated usage is
        what Claude Code estimates each run would cost in US dollars: your subscription does not
        charge it, but it follows what runs use of your quota.
      </p>
      <fieldset>
        <legend className="font-medium text-slate-800">Budget</legend>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-2">
          {choices.map((choice) => (
            <label key={choice.value} className="flex items-center gap-2">
              <input
                type="radio"
                name={`budget-${account.id}`}
                checked={kind === choice.value}
                onChange={() => {
                  setKind(choice.value);
                  changed();
                }}
              />
              {choice.label}
            </label>
          ))}
        </div>
      </fieldset>
      {kind === 'working_time' && (
        <TextField
          label="Minutes of working time a day"
          hint={`From ${String(DAILY_BUDGET.minutes.min)} to ${String(DAILY_BUDGET.minutes.max)} minutes.`}
          type="number"
          inputMode="numeric"
          min={DAILY_BUDGET.minutes.min}
          max={DAILY_BUDGET.minutes.max}
          value={minutes}
          error={checked ? minutesError : null}
          onChange={(event) => {
            setMinutes(event.target.value);
            changed();
          }}
        />
      )}
      {kind === 'estimated_usage' && (
        <TextField
          label="US dollars of estimated usage a day"
          hint="For example 5.00. From $0.01."
          type="number"
          inputMode="decimal"
          step="0.01"
          min={DAILY_BUDGET.usd.min}
          value={usd}
          error={checked ? usdError : null}
          onChange={(event) => {
            setUsd(event.target.value);
            changed();
          }}
        />
      )}
      {save.error && <ErrorMessage>{refusalText(save.error)}</ErrorMessage>}
      {saved && <p className="text-green-800">Daily budget saved.</p>}
      <Button type="submit" disabled={save.isPending}>
        Save the budget
      </Button>
    </form>
  );
}
