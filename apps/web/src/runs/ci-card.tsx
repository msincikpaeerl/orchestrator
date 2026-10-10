import type { CiCheckView, Run } from '@orchestrator/protocol';
import { Card, WarningMessage } from '../components/ui';
import { safeUrl } from '../components/markdown';
import { ciHistoryLines } from './ci-outcome-text';
import { ciCheckKindLabel, ciCheckStateLabel, ciProblemText, ciWaitText } from './ci-text';
import { useNow } from './components';

const STATE_STYLE = {
  pending: 'text-slate-700',
  passed: 'text-green-800',
  failed: 'text-red-800',
} as const;

/**
 * The run page's CI card while the run waits for CI (02, section 7; lot 3 step G1b): what it
 * waits for and until when, why GitHub could not be checked at the latest check, and each
 * workflow run and status of the submitted commit. Names come from GitHub: plain text, and
 * links only through the allow-list (ADR 0024).
 */
export function CiWaitCard({ run }: { run: Run }) {
  const now = useNow(true);
  const ci = run.ci;
  if (ci === null || run.status !== 'running') return null;
  const lines = ciWaitText(ci, new Date(now));
  const conflict = ci.result?.state === 'conflict';
  const checks = ci.result?.checks ?? [];
  return (
    <Card className="space-y-3">
      <h2 className="text-lg font-semibold text-slate-900">CI</h2>
      <div className="space-y-1" aria-label="Waiting for CI">
        {lines.map((line, index) =>
          conflict && index === lines.length - 1 ? (
            <WarningMessage key={line}>{line}</WarningMessage>
          ) : (
            <p key={line} className={index === 0 ? 'break-words text-slate-900' : 'text-slate-700'}>
              {line}
            </p>
          ),
        )}
      </div>
      {ci.checkFailure && (
        <div className="break-words" aria-label="GitHub problem">
          <WarningMessage>{ciProblemText(ci.checkFailure)}</WarningMessage>
        </div>
      )}
      {checks.length > 0 && <CiChecks checks={checks} />}
    </Card>
  );
}

/** Each workflow run and status of a result, with its state and its link on GitHub. */
function CiChecks({ checks, label = 'CI checks' }: { checks: CiCheckView[]; label?: string }) {
  return (
    <ul aria-label={label} className="space-y-1">
      {checks.map((check, index) => {
        const link = check.url === null ? null : safeUrl(check.url);
        return (
          <li key={`${check.kind}-${String(index)}`} className="break-words">
            <span className="text-slate-900">{check.name}</span>
            <span className="text-slate-600"> · {ciCheckKindLabel[check.kind]}</span>{' '}
            <span className={`font-medium ${STATE_STYLE[check.state]}`}>
              {ciCheckStateLabel[check.state]}
            </span>
            {link && (
              <>
                {' '}
                <a
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-700 underline"
                >
                  on GitHub
                </a>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The run page's CI rounds and what its CI came to (02, section 7; owner's answer 2, lot 3 step
 * G2c): one line per round, the result that ended the run when it was not sent back, and the work
 * accepted later. Each line lists its checks, the latest open and the earlier ones folded.
 */
export function CiHistoryCard({ run }: { run: Run }) {
  const history = run.ciHistory;
  if (history === null) return null;
  const lines = ciHistoryLines(history, run);
  if (lines.length === 0) return null;
  const lastWithChecks = lines.findLastIndex((line) => line.checks.length > 0);
  return (
    <Card className="space-y-3">
      <h2 className="text-lg font-semibold text-slate-900">
        {run.status === 'running' && run.ci !== null ? 'Earlier CI rounds' : 'CI'}
      </h2>
      <ol aria-label="CI rounds" className="space-y-2">
        {lines.map((line, index) => (
          <li key={line.label} className="space-y-1">
            {line.checks.length === 0 ? (
              <p className="break-words text-slate-900">{line.label}</p>
            ) : (
              <details open={index === lastWithChecks}>
                <summary className="cursor-pointer break-words text-slate-900">
                  {line.label}
                </summary>
                <div className="mt-1 pl-4">
                  <CiChecks checks={line.checks} label={`Checks of ${line.label}`} />
                </div>
              </details>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}
