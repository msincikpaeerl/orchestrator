import { Project } from '@orchestrator/protocol';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { Button, ConfirmDialog, ErrorMessage } from '../components/ui';
import { projectsChanged } from '../queries';
import { refusalText } from './text';

/**
 * **Archive** or **Unarchive**, after a confirmation saying what happens (02, section 6.1). The
 * GitHub repository is never changed (01, section 3.1).
 */
export function ArchiveAction({ project }: { project: Project }) {
  const [asking, setAsking] = useState(false);
  const archiving = project.status === 'active';
  const action = archiving ? 'Archive' : 'Unarchive';
  const change = useMutation({
    mutationFn: () =>
      api(
        'POST',
        `/api/projects/${encodeURIComponent(project.key)}/${archiving ? 'archive' : 'unarchive'}`,
        Project,
      ),
    onSuccess: async (changed) => {
      setAsking(false);
      await projectsChanged(changed);
    },
  });
  const repository = `${project.repository.owner}/${project.repository.name}`;

  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          change.reset();
          setAsking(true);
        }}
      >
        {action}
      </Button>
      {asking && (
        <ConfirmDialog
          title={`${action} ${project.key} ${project.name}?`}
          confirmLabel={action}
          busy={change.isPending}
          error={change.error && <ErrorMessage>{refusalText(change.error).text}</ErrorMessage>}
          onConfirm={() => {
            change.mutate();
          }}
          onCancel={() => {
            setAsking(false);
          }}
        >
          {archiving ? (
            <p>
              The project and its tickets are kept but become read-only, and no new work starts on
              it. It is hidden from the project list until you choose “Show archived”. You can
              unarchive it later.
            </p>
          ) : (
            <p>The project becomes active again and appears in the project list.</p>
          )}
          <p className="font-medium">The GitHub repository {repository} is not changed.</p>
        </ConfirmDialog>
      )}
    </>
  );
}
