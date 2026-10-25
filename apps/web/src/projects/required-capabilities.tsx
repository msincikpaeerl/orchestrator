import {
  Capability,
  Project,
  SetRequiredCapabilitiesRequest,
  type Project as ProjectData,
} from '@orchestrator/protocol';
import { useMutation } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { api } from '../api';
import { Button, Card, ErrorMessage, HelpLink, TextField } from '../components/ui';
import { projectsChanged } from '../queries';
import { refusalText, requiredCapabilitiesCard as text } from './text';

/**
 * The card **Required capabilities** of Project settings (02, section 6.5; lot 5 step C2): each
 * change sends the whole list the project should require, and is saved at once.
 */
export function RequiredCapabilitiesCard({ project }: { project: ProjectData }) {
  const [typed, setTyped] = useState('');
  const [typedError, setTypedError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (capabilities: string[]) =>
      api(
        'PUT',
        `/api/projects/${encodeURIComponent(project.key)}/required-capabilities`,
        Project,
        SetRequiredCapabilitiesRequest.parse({ capabilities }),
      ),
    onSuccess: (changed) => projectsChanged(changed),
  });
  const editable = project.status === 'active';
  const required = project.requiredCapabilities;

  function add(event: SubmitEvent) {
    event.preventDefault();
    const parsed = Capability.safeParse(typed.trim().toLowerCase());
    if (!parsed.success) {
      setTypedError(text.invalid);
      return;
    }
    if (required.includes(parsed.data)) {
      setTypedError(text.duplicate);
      return;
    }
    save.mutate([...required, parsed.data]);
    setTyped('');
  }

  return (
    <Card className="space-y-3">
      <h2 className="text-lg font-semibold text-slate-900">{text.heading}</h2>
      <p className="text-slate-700">{text.hint}</p>
      {required.length === 0 ? (
        <p className="text-slate-700">{text.none}</p>
      ) : (
        <ul aria-label={text.heading} className="divide-y divide-slate-200">
          {required.map((tag) => (
            <li key={tag} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="font-mono">{tag}</span>
              {editable && (
                <Button
                  variant="secondary"
                  className="py-1 text-sm"
                  disabled={save.isPending}
                  aria-label={`Remove ${tag}`}
                  onClick={() => {
                    save.mutate(required.filter((other) => other !== tag));
                  }}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {save.error && <ErrorMessage>{refusalText(save.error).text}</ErrorMessage>}
      {save.isSuccess && (
        <p role="status" className="text-green-800">
          {text.saved}
        </p>
      )}
      {editable ? (
        <form
          onSubmit={add}
          aria-label="New required capability"
          className="flex flex-wrap items-end gap-2"
          noValidate
        >
          <div className="min-w-0 flex-1">
            <TextField
              label={text.addLabel}
              hint={text.addHint}
              value={typed}
              error={typedError}
              onChange={(event) => {
                setTyped(event.target.value);
                setTypedError(null);
                save.reset();
              }}
            />
          </div>
          <Button type="submit" disabled={save.isPending}>
            Add
          </Button>
        </form>
      ) : (
        <p className="text-slate-700">{text.archived}</p>
      )}
      <p className="text-sm text-slate-600">
        <HelpLink page="projects#required-capabilities">Required capabilities</HelpLink>
      </p>
    </Card>
  );
}
