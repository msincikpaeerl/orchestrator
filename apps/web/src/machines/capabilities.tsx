import { Capability, Machine, SetCapabilitiesRequest } from '@orchestrator/protocol';
import { useMutation } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { api } from '../api';
import { Button, ErrorMessage, TextField } from '../components/ui';
import { machinesChanged } from '../queries';
import { refusalText } from '../refusals';
import { capabilitySourceText } from './text';

/**
 * The machine's capabilities, each with where it comes from, and the owner's changes (02,
 * section 9.2; 01, section 3.8). Each change sends the whole list the machine should have.
 */
export function CapabilitiesEditor({ machine }: { machine: Machine }) {
  const [typed, setTyped] = useState('');
  const [typedError, setTypedError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (capabilities: string[]) =>
      api(
        'PUT',
        `/api/machines/${machine.id}/capabilities`,
        Machine,
        SetCapabilitiesRequest.parse({ capabilities }),
      ),
    onSuccess: (changed) => machinesChanged(changed),
  });
  const editable = machine.state !== 'revoked';

  function change(tag: string, keep: boolean) {
    const others = machine.capabilities.filter((existing) => existing !== tag);
    save.mutate(keep ? [...others, tag] : others);
  }

  function add(event: SubmitEvent) {
    event.preventDefault();
    const parsed = Capability.safeParse(typed.trim().toLowerCase());
    if (!parsed.success) {
      setTypedError('Use lowercase letters and digits, with “-” between words: android-sdk.');
      return;
    }
    if (machine.capabilities.includes(parsed.data)) {
      setTypedError('The machine already has this capability.');
      return;
    }
    change(parsed.data, true);
    setTyped('');
  }

  return (
    <div className="space-y-3">
      {machine.capabilitySources.length === 0 ? (
        <p className="text-slate-700">
          None yet: the daemon reports what it finds when it connects.
        </p>
      ) : (
        <ul aria-label="Capabilities" className="divide-y divide-slate-200">
          {machine.capabilitySources.map((source) => {
            const removed = source.source === 'removed';
            return (
              <li
                key={source.tag}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <span className={removed ? 'text-slate-500 line-through' : ''}>
                  <span className="font-mono">{source.tag}</span>{' '}
                  <span className="text-sm text-slate-600">({capabilitySourceText(source)})</span>
                </span>
                {editable && (
                  <Button
                    variant="secondary"
                    className="py-1 text-sm"
                    disabled={save.isPending}
                    aria-label={`${removed ? 'Add back' : 'Remove'} ${source.tag}`}
                    onClick={() => {
                      change(source.tag, removed);
                    }}
                  >
                    {removed ? 'Add back' : 'Remove'}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {save.error && <ErrorMessage>{refusalText(save.error)}</ErrorMessage>}
      {editable && (
        <form
          onSubmit={add}
          aria-label="New capability"
          className="flex flex-wrap items-end gap-2"
          noValidate
        >
          <div className="min-w-0 flex-1">
            <TextField
              label="Add a capability"
              hint="For example android-sdk, when the machine has a tool the daemon does not detect."
              value={typed}
              error={typedError}
              onChange={(event) => {
                setTyped(event.target.value);
                setTypedError(null);
              }}
            />
          </div>
          <Button type="submit" disabled={save.isPending}>
            Add
          </Button>
        </form>
      )}
    </div>
  );
}
