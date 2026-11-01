import type { AgentKey } from '@orchestrator/protocol';
import { Link } from 'react-router';
import { Button, SelectField, TextArea } from '../components/ui';
import { useAgents } from '../queries';

// Fields shared by the ticket form and the plan review's edit (owner's answer 2, lot 5 step F2).

function move<T>(list: readonly T[], from: number, to: number): T[] {
  const copy = [...list];
  const [item] = copy.splice(from, 1);
  if (item !== undefined) copy.splice(to, 0, item);
  return copy;
}

/** The ordered acceptance criteria: add, change, move up or down, remove. */
export function CriteriaEditor({
  criteria,
  onChange,
}: {
  criteria: string[];
  onChange: (criteria: string[]) => void;
}) {
  return (
    <fieldset className="space-y-3">
      <legend className="font-medium text-slate-800">Acceptance criteria</legend>
      <p className="text-sm text-slate-600">
        Statements that must be true when the ticket is done, in order. Empty ones are left out.
      </p>
      {criteria.length > 0 && (
        <ol className="space-y-3">
          {criteria.map((criterion, index) => {
            const number = String(index + 1);
            return (
              <li key={index} className="space-y-2 rounded border border-slate-200 p-3">
                <TextArea
                  label={`Acceptance criterion ${number}`}
                  rows={2}
                  value={criterion}
                  onChange={(event) => {
                    onChange(criteria.map((each, i) => (i === index ? event.target.value : each)));
                  }}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    className="px-3 py-1 text-sm"
                    disabled={index === 0}
                    aria-label={`Move criterion ${number} up`}
                    onClick={() => {
                      onChange(move(criteria, index, index - 1));
                    }}
                  >
                    Move up
                  </Button>
                  <Button
                    variant="secondary"
                    className="px-3 py-1 text-sm"
                    disabled={index === criteria.length - 1}
                    aria-label={`Move criterion ${number} down`}
                    onClick={() => {
                      onChange(move(criteria, index, index + 1));
                    }}
                  >
                    Move down
                  </Button>
                  <Button
                    variant="secondary"
                    className="px-3 py-1 text-sm"
                    aria-label={`Remove criterion ${number}`}
                    onClick={() => {
                      onChange(criteria.filter((_, i) => i !== index));
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <Button
        variant="secondary"
        onClick={() => {
          onChange([...criteria, '']);
        }}
      >
        Add a criterion
      </Button>
    </fieldset>
  );
}

/** The agent expected to do the work: any profile until lot 7 (01, section 3.4). */
export function AssigneeField({
  value,
  onChange,
}: {
  value: AgentKey | null;
  onChange: (assignee: AgentKey | null) => void;
}) {
  const agents = useAgents();
  // Only agents that implement: Quality reviews and is never assigned (03, section 4).
  const listed = (agents.data?.agents ?? []).filter(
    (agent) => agent.role === 'builder' || agent.role === 'writer',
  );
  return (
    <SelectField
      label="Assignee"
      hint={
        <>
          The agent expected to do the work.{' '}
          <Link to="/help/agents" className="text-blue-700 underline">
            About agents
          </Link>
        </>
      }
      value={value ?? ''}
      disabled={agents.isPending}
      onChange={(event) => {
        onChange(event.target.value === '' ? null : event.target.value);
      }}
    >
      <option value="">No assignee</option>
      {listed.map((agent) => (
        <option key={agent.key} value={agent.key}>
          {agent.name}
        </option>
      ))}
      {value !== null && !listed.some((agent) => agent.key === value) && (
        <option value={value}>{value}</option>
      )}
    </SelectField>
  );
}
