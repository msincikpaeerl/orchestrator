import {
  CreateMachineRequest,
  EnrollmentResponse,
  NAME_MAX_LENGTH,
  type Enrollment,
} from '@orchestrator/protocol';
import { useMutation } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { Link } from 'react-router';
import { api, ApiRequestError } from '../api';
import {
  Button,
  Card,
  ErrorMessage,
  Loading,
  PageHeader,
  SelectField,
  TextField,
} from '../components/ui';
import { EnrollmentSteps } from '../machines/enrollment';
import { machinesChanged, useAccounts, useMachine } from '../queries';
import { refusalText } from '../refusals';

/** The commands of the new machine, and its connection as the page learns it. */
function Connect({ machineId, enrollment }: { machineId: string; enrollment: Enrollment }) {
  const machine = useMachine(machineId);
  if (machine.isPending) return <Loading />;
  if (machine.isError) {
    return <ErrorMessage>The machine could not be loaded. Reload the page.</ErrorMessage>;
  }
  return <EnrollmentSteps enrollment={enrollment} machine={machine.data} />;
}

/**
 * **Add machine** (02, section 9.2): name and Claude account, then the commands to type on the
 * machine, then waits until it connects.
 */
export function AddMachinePage() {
  const accounts = useAccounts();
  const [name, setName] = useState('');
  const [accountId, setAccountId] = useState('');
  const [touched, setTouched] = useState(false);
  const create = useMutation({
    mutationFn: (input: CreateMachineRequest) =>
      api('POST', '/api/machines', EnrollmentResponse, input),
    onSuccess: (result) => machinesChanged(result.machine),
  });

  if (accounts.isPending) return <Loading />;
  if (accounts.isError) {
    return <ErrorMessage>The Claude accounts could not be loaded. Reload the page.</ErrorMessage>;
  }
  const list = accounts.data.accounts;
  const chosen = accountId || (list.length === 1 ? (list[0]?.id ?? '') : '');
  const nameError = touched && name.trim() === '' ? 'Enter a name.' : null;
  const accountError = touched && chosen === '' ? 'Choose the Claude account.' : null;
  const nameTaken =
    create.error instanceof ApiRequestError && create.error.code === 'machine_name_taken';

  function submit(event: SubmitEvent) {
    event.preventDefault();
    setTouched(true);
    if (name.trim() === '' || chosen === '') return;
    create.mutate({ name: name.trim(), accountId: chosen });
  }

  return (
    <>
      <PageHeader title="Add machine" help="machines#add-a-machine" />
      {create.data ? (
        <Connect machineId={create.data.machine.id} enrollment={create.data.enrollment} />
      ) : list.length === 0 ? (
        <Card className="space-y-2">
          <p>Each machine uses a Claude account. Add the account first.</p>
          <Link to="/machines" className="text-blue-700 underline">
            Open Machines
          </Link>
        </Card>
      ) : (
        <Card>
          <form className="space-y-4" onSubmit={submit} aria-label="New machine" noValidate>
            <TextField
              label="Name"
              hint="How the Orchestrator names this computer, for example “Desktop”."
              value={name}
              maxLength={NAME_MAX_LENGTH}
              error={nameError ?? (nameTaken ? refusalText(create.error) : null)}
              onChange={(event) => {
                setName(event.target.value);
                create.reset();
              }}
            />
            <SelectField
              label="Claude account"
              hint="The account you will log into on this machine."
              value={chosen}
              error={accountError}
              onChange={(event) => {
                setAccountId(event.target.value);
                create.reset();
              }}
            >
              {list.length > 1 && <option value="">Choose…</option>}
              {list.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label}
                </option>
              ))}
            </SelectField>
            {create.error && !nameTaken && <ErrorMessage>{refusalText(create.error)}</ErrorMessage>}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={create.isPending}>
                Show the commands
              </Button>
              <Link to="/machines" className="self-center text-blue-700 underline">
                Cancel
              </Link>
            </div>
          </form>
        </Card>
      )}
    </>
  );
}
