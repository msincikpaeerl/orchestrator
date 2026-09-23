import {
  ProjectSettingsResponse,
  SetSettingRequest,
  type Project,
  type ProjectSetting,
  type SettingName,
} from '@orchestrator/protocol';
import { useMutation } from '@tanstack/react-query';
import { api } from '../api';
import { Card, ErrorMessage, HelpLink, Loading } from '../components/ui';
import { keys, queryClient, useProjectSettings } from '../queries';
import { SettingEditor } from './setting-editor';
import { amount } from './text';

function OverrideEditor({ project, setting }: { project: Project; setting: ProjectSetting }) {
  const { name, override, globalValue } = setting;
  const path = (setting: SettingName) =>
    `/api/projects/${encodeURIComponent(project.key)}/settings/${encodeURIComponent(setting)}`;
  const change = useMutation({
    mutationFn: (next: number | null) =>
      next === null
        ? api('DELETE', path(name), ProjectSettingsResponse)
        : api('PUT', path(name), ProjectSettingsResponse, {
            value: next,
          } satisfies SetSettingRequest),
    onSuccess: (settings) => {
      queryClient.setQueryData(keys.projectSettings(project.key), settings);
    },
  });
  return (
    <SettingEditor
      name={name}
      value={override ?? globalValue}
      canReset={override !== null}
      details={
        override === null ? (
          <p>This project uses the global value ({amount(name, globalValue)}).</p>
        ) : (
          <p>This project uses its own value. Global value: {amount(name, globalValue)}.</p>
        )
      }
      disabled={project.status === 'archived'}
      busy={change.isPending}
      saved={change.isSuccess}
      error={change.error}
      onSave={(next) => {
        change.mutate(next);
      }}
      onReset={() => {
        change.mutate(null);
      }}
    />
  );
}

/**
 * The settings a project can override (02, section 6.5): a value here replaces the one of
 * Settings > Limits for this project only; **Reset to default** returns to the global value.
 */
export function ProjectOverrides({ project }: { project: Project }) {
  const settings = useProjectSettings(project.key);
  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-slate-900">Limits for this project</h2>
        <HelpLink page="settings#override-a-limit-for-one-project" />
      </div>
      <p className="mb-4 text-slate-700">
        {project.status === 'archived'
          ? 'Unarchive the project to change its limits.'
          : 'A value saved here replaces the one of Settings > Limits for this project only. Reset to default uses the global value again.'}
      </p>
      {settings.isPending && <Loading />}
      {settings.isError && <ErrorMessage>The project's limits could not be loaded.</ErrorMessage>}
      {settings.data && (
        <div className="divide-y divide-slate-200">
          {settings.data.settings.map((setting) => (
            <OverrideEditor key={setting.name} project={project} setting={setting} />
          ))}
        </div>
      )}
    </Card>
  );
}
