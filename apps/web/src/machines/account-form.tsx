import {
  AccountPlan,
  ClaudeAccount,
  MAX_CONCURRENT_RUNS,
  NAME_MAX_LENGTH,
  type CreateAccountRequest,
  type UpdateAccountRequest,
} from '@orchestrator/protocol';
import { useMutation } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { api, ApiRequestError } from '../api';
import { Button, ErrorMessage, SelectField, TextField } from '../components/ui';
import { machinesChanged } from '../queries';
import { refusalText } from '../refusals';
import { planLabel } from './text';

const runChoices = Array.from(
  { length: MAX_CONCURRENT_RUNS.max - MAX_CONCURRENT_RUNS.min + 1 },
  (_, index) => MAX_CONCURRENT_RUNS.min + index,
);

/**
 * Adds a Claude account, or edits `account` (02, section 9.1): label, plan and maximum
 * concurrent runs. Only the changed fields are sent.
 */
export function AccountForm({ account, onDone }: { account?: ClaudeAccount; onDone: () => void }) {
  const [label, setLabel] = useState(account?.label ?? '');
  const [plan, setPlan] = useState<AccountPlan>(account?.plan ?? 'pro');
  const [runs, setRuns] = useState(account?.maxConcurrentRuns ?? MAX_CONCURRENT_RUNS.default);
  const [touched, setTouched] = useState(false);
  const save = useMutation({
    mutationFn: (input: CreateAccountRequest | UpdateAccountRequest) =>
      account
        ? api('PATCH', `/api/accounts/${account.id}`, ClaudeAccount, input)
        : api('POST', '/api/accounts', ClaudeAccount, input),
    onSuccess: async () => {
      await machinesChanged();
      onDone();
    },
  });
  const labelError = touched && label.trim() === '' ? 'Enter a label.' : null;
  const labelTaken =
    save.error instanceof ApiRequestError && save.error.code === 'account_label_taken';

  function submit(event: SubmitEvent) {
    event.preventDefault();
    setTouched(true);
    if (label.trim() === '') return;
    if (!account) {
      save.mutate({ label: label.trim(), plan, maxConcurrentRuns: runs });
      return;
    }
    const changes: UpdateAccountRequest = {};
    if (label.trim() !== account.label) changes.label = label.trim();
    if (plan !== account.plan) changes.plan = plan;
    if (runs !== account.maxConcurrentRuns) changes.maxConcurrentRuns = runs;
    if (Object.keys(changes).length === 0) {
      onDone();
      return;
    }
    save.mutate(changes);
  }

  return (
    <form
      className="space-y-4"
      onSubmit={submit}
      aria-label={account ? `Edit ${account.label}` : 'New Claude account'}
      noValidate
    >
      <TextField
        label="Label"
        hint="A name you recognise, for example “Personal”."
        value={label}
        maxLength={NAME_MAX_LENGTH}
        error={labelError ?? (labelTaken ? refusalText(save.error) : null)}
        onChange={(event) => {
          setLabel(event.target.value);
          save.reset();
        }}
      />
      <SelectField
        label="Plan"
        hint="Your Claude subscription. For your information only in this version."
        value={plan}
        onChange={(event) => {
          setPlan(AccountPlan.parse(event.target.value));
          save.reset();
        }}
      >
        {AccountPlan.options.map((option) => (
          <option key={option} value={option}>
            {planLabel[option]}
          </option>
        ))}
      </SelectField>
      <SelectField
        label="Runs at the same time"
        hint="How many agents may work at once with this account, on all its machines together."
        value={String(runs)}
        onChange={(event) => {
          setRuns(Number(event.target.value));
          save.reset();
        }}
      >
        {runChoices.map((count) => (
          <option key={count} value={count}>
            {count}
          </option>
        ))}
      </SelectField>
      {save.error && !labelTaken && <ErrorMessage>{refusalText(save.error)}</ErrorMessage>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={save.isPending}>
          {account ? 'Save' : 'Add the account'}
        </Button>
        <Button variant="secondary" onClick={onDone} disabled={save.isPending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
