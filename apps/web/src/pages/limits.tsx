import {
  GlobalSettingsResponse,
  SETTINGS,
  SetSettingRequest,
  SettingGroup,
  type GlobalSetting,
  type SettingName,
} from '@orchestrator/protocol';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../api';
import { Card, ErrorMessage, Loading, PageHeader } from '../components/ui';
import { settingsChanged, useGlobalSettings } from '../queries';
import { SettingEditor } from '../settings/setting-editor';
import { amount, groupTitle } from '../settings/text';

function settingPath(name: SettingName) {
  return `/api/settings/${encodeURIComponent(name)}`;
}

function GlobalSettingEditor({ setting }: { setting: GlobalSetting }) {
  const { name, value, isDefault } = setting;
  const change = useMutation({
    mutationFn: (next: number | null) =>
      next === null
        ? api('DELETE', settingPath(name), GlobalSettingsResponse)
        : api('PUT', settingPath(name), GlobalSettingsResponse, {
            value: next,
          } satisfies SetSettingRequest),
    onSuccess: (settings) => settingsChanged(settings),
  });
  return (
    <SettingEditor
      name={name}
      value={value}
      canReset={!isDefault}
      details={
        <>
          <p>
            Default: {amount(name, SETTINGS[name].default)}
            {isDefault ? ' (in use).' : '.'}
          </p>
          {SETTINGS[name].perProject && (
            <p>A project can use its own value, in its project settings.</p>
          )}
        </>
      }
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

/** Settings > Limits (02, section 10; 04, section 8): every setting with its default. */
export function LimitsPage() {
  const settings = useGlobalSettings();
  return (
    <>
      <PageHeader title="Limits" help="settings#change-a-limit" />
      <div className="space-y-4">
        <Link to="/settings" className="inline-block text-blue-700 underline">
          Back to Settings
        </Link>
        <p className="text-slate-700">
          A change applies to what happens next: work already started keeps the values it started
          with.
        </p>
        {settings.isPending && <Loading />}
        {settings.isError && <ErrorMessage>The settings could not be loaded.</ErrorMessage>}
        {settings.data &&
          SettingGroup.options.map((group) => {
            const inGroup = settings.data.settings.filter(
              (setting) => SETTINGS[setting.name].group === group,
            );
            if (inGroup.length === 0) return null;
            return (
              <Card key={group}>
                <h2 className="mb-4 text-lg font-semibold text-slate-900">{groupTitle[group]}</h2>
                <div className="divide-y divide-slate-200">
                  {inGroup.map((setting) => (
                    <GlobalSettingEditor key={setting.name} setting={setting} />
                  ))}
                </div>
              </Card>
            );
          })}
      </div>
    </>
  );
}
