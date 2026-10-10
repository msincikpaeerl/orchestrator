import { CheckCiAgainResponse } from '@orchestrator/protocol';
import { useMutation } from '@tanstack/react-query';
import { api } from '../api';
import { Button, ErrorMessage, InfoMessage } from '../components/ui';
import { ticketsChanged } from '../queries';
import { refusalText } from '../refusals';
import { checkCiAgainText } from '../runs/ci-outcome-text';
import { ticketApi, type TicketAddress } from './actions';
import { ticketRef } from './text';

/**
 * **Check CI again** (04, section 3.1; lot 3 step G2c): one reading of the run's commit on GitHub,
 * starting no session, on the ticket page and in "Needs you". What it found is said beside it;
 * the screens are read again after it.
 */
export function CheckCiAgainAction({
  ticket,
  runId,
  onAccepted,
}: {
  ticket: TicketAddress;
  runId: string;
  /** The work accepted: where the action is gone with it, the page says so (Needs you). */
  onAccepted?: (said: string) => void;
}) {
  const check = useMutation({
    mutationFn: () =>
      api('POST', ticketApi(ticket, '/ci/check-again'), CheckCiAgainResponse, { runId }),
    onSuccess: (answer) => {
      if (answer.outcome === 'accepted') {
        onAccepted?.(checkCiAgainText(answer, ticketRef(ticket.projectKey, ticket.number)));
      }
    },
    onSettled: () => ticketsChanged(),
  });
  return (
    <div className="space-y-2">
      <Button
        onClick={() => {
          check.mutate();
        }}
        disabled={check.isPending}
      >
        {check.isPending ? 'Checking CI on GitHub…' : 'Check CI again'}
      </Button>
      {check.data && (
        <div role="status">
          <InfoMessage>
            {checkCiAgainText(check.data, ticketRef(ticket.projectKey, ticket.number))}
          </InfoMessage>
        </div>
      )}
      {check.error && <ErrorMessage>{refusalText(check.error)}</ErrorMessage>}
    </div>
  );
}
