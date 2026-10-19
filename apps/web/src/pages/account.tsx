import type { AccountDetailResponse, TimeZoneResponse } from '@orchestrator/protocol';
import { Link, useParams } from 'react-router';
import { Card, ErrorMessage, InfoMessage, Loading, PageHeader } from '../components/ui';
import { formatDate, formatDateTime } from '../github/text';
import {
  AccountDayLines,
  BudgetEditor,
  PauseButton,
  ScheduleEditor,
} from '../machines/account-parts';
import { budgetText, scheduleText, usdText } from '../machines/schedule-text';
import { concurrentRuns, planLabel } from '../machines/text';
import { useAccount } from '../queries';
import { AccountStatusText, ResetCountdown } from '../runs/components';
import { durationText } from '../runs/text';

/** Where the windows and days are read, and how to change it (02, section 10). */
export function TimeZoneNote({ timeZone }: { timeZone: TimeZoneResponse }) {
  return timeZone.saved ? (
    <p className="text-sm text-slate-600">
      Windows and days are read in the Orchestrator's time zone, {timeZone.timeZone} (
      <Link to="/settings" className="text-blue-700 underline">
        Settings
      </Link>
      ).
    </p>
  ) : (
    <InfoMessage>
      No time zone is saved yet, so windows and days are read in UTC. Save yours in{' '}
      <Link to="/settings" className="text-blue-700 underline">
        Settings
      </Link>
      .
    </InfoMessage>
  );
}

function Days({ days }: { days: AccountDetailResponse['days'] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-slate-700">
            <th className="py-1 pr-3 font-medium">Day</th>
            <th className="py-1 pr-3 font-medium">Runs</th>
            <th className="py-1 pr-3 font-medium">Working</th>
            <th className="py-1 font-medium">Estimated usage</th>
          </tr>
        </thead>
        <tbody>
          {days.map((day) => (
            <tr key={day.date} className="border-b border-slate-100">
              <td className="py-1 pr-3 whitespace-nowrap">{formatDate(day.date)}</td>
              <td className="py-1 pr-3">{day.runs}</td>
              <td className="py-1 pr-3">{durationText(day.workingMs)}</td>
              <td className="py-1">
                {usdText(day.estimatedUsageUsd)}
                {day.runsWithoutEstimate > 0 &&
                  ` (${String(day.runsWithoutEstimate)} without an estimate)`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Limits({ detail }: { detail: AccountDetailResponse }) {
  if (detail.limits.length === 0) {
    return <p className="text-slate-700">This account has not reached its usage limit yet.</p>;
  }
  const older = detail.limitCount - detail.limits.length;
  return (
    <>
      <ul aria-label="Usage limits reached" className="space-y-1">
        {detail.limits.map((limit) => (
          <li key={limit.at} className="break-words">
            {formatDateTime(limit.at)}: no run until {formatDateTime(limit.until)}
            {limit.source === 'fallback'
              ? ' (estimated: Claude Code gave no reset time)'
              : ' (the reset time Claude Code gave)'}
          </li>
        ))}
      </ul>
      {older > 0 && (
        <p className="text-sm text-slate-600">
          And {older} earlier, in Activity (filter: Claude accounts).
        </p>
      )}
    </>
  );
}

/** A Claude account's page (02, section 9.1; lot 4 step C). */
export function AccountPage() {
  const { id = '' } = useParams();
  const detail = useAccount(id);
  if (detail.isPending) return <Loading />;
  if (detail.isError) {
    return <ErrorMessage>This Claude account could not be loaded. Reload the page.</ErrorMessage>;
  }
  const { account, timeZone } = detail.data;
  return (
    <>
      <PageHeader title={account.label} help="machines" />
      <div className="space-y-4">
        <Link to="/machines" className="text-blue-700 underline">
          Back to Machines
        </Link>
        <Card className="space-y-2">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-1">
              <p className="text-slate-900">
                State: <AccountStatusText account={account} />
                <ResetCountdown account={account} />
              </p>
              <p className="text-slate-700">
                {planLabel[account.plan]} · {concurrentRuns(account.maxConcurrentRuns)}
              </p>
              <AccountDayLines account={account} />
            </div>
            <div className="flex shrink-0 flex-col gap-2">
              <PauseButton account={account} />
            </div>
          </div>
          <TimeZoneNote timeZone={timeZone} />
        </Card>
        <Card className="space-y-3">
          <h2 className="text-lg font-semibold text-slate-900">Schedule windows</h2>
          <p className="text-slate-900">{scheduleText(account.schedule)}</p>
          <ScheduleEditor
            key={JSON.stringify(account.schedule)}
            account={account}
            timeZone={timeZone.timeZone}
          />
        </Card>
        <Card className="space-y-3">
          <h2 className="text-lg font-semibold text-slate-900">Daily budget</h2>
          <p className="text-slate-900">{budgetText(account.dailyBudget)}</p>
          <BudgetEditor
            key={JSON.stringify(account.dailyBudget)}
            account={account}
            timeZone={timeZone.timeZone}
          />
        </Card>
        <Card className="space-y-3">
          <h2 className="text-lg font-semibold text-slate-900">Estimated usage per day</h2>
          <p className="text-slate-700">
            The runs started each day, a run counted whole on the day it started.
          </p>
          <Days days={detail.data.days} />
        </Card>
        <Card className="space-y-3">
          <h2 className="text-lg font-semibold text-slate-900">Usage limits reached</h2>
          <Limits detail={detail.data} />
        </Card>
      </div>
    </>
  );
}
