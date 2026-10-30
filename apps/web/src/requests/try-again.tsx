import { RequestDetail } from '@orchestrator/protocol';
import { useMutation } from '@tanstack/react-query';
import { api } from '../api';
import { Button, ErrorMessage } from '../components/ui';
import { requestsChanged } from '../queries';
import { refusalText } from '../refusals';

/**
 * **Try again** on a stopped request (owner's answer 7, lot 5 step E2): no confirmation, since it
 * starts no session; the Project Manager plans the request again when a machine can.
 */
export function RequestTryAgain({ number }: { number: number }) {
  const tryAgain = useMutation({
    mutationFn: () => api('POST', `/api/requests/${String(number)}/try-again`, RequestDetail),
    onSuccess: (changed) => requestsChanged(changed),
    onError: () => requestsChanged(),
  });
  return (
    <div className="space-y-2">
      <Button
        onClick={() => {
          tryAgain.mutate();
        }}
        disabled={tryAgain.isPending}
      >
        Try again
      </Button>
      {tryAgain.error && <ErrorMessage>{refusalText(tryAgain.error)}</ErrorMessage>}
    </div>
  );
}
