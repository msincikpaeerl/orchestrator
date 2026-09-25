import type { NeedsYouItem } from '@orchestrator/protocol';
import { Link } from 'react-router';
import { Card, HelpLink, Loading, PageHeader } from '../components/ui';
import { problemText } from '../github/text';
import { Command } from '../machines/command';
import { needsYouText, RESTART_COMMAND } from '../machines/text';
import { sentence, stepLabel } from '../projects/text';
import { useGitHubStatus, useNeedsYou } from '../queries';

function itemKey(item: NeedsYouItem): string {
  if (item.type === 'project_setup_failed') return `${item.type}-${item.project.key}`;
  if ('machine' in item) return `${item.type}-${item.machine.id}`;
  return item.type;
}

type MachineItem = Exclude<NeedsYouItem, { type: 'project_setup_failed' }>;

/** Setup still to do and machine problems (02, section 4), with where to fix them. */
function MachineItemCard({ item }: { item: MachineItem }) {
  const { title, detail } = needsYouText(item);
  return (
    <Card className="space-y-2">
      <h2 className="font-semibold break-words text-slate-900">{title}</h2>
      <p className="break-words text-slate-700">{detail}</p>
      {item.type === 'machine_problem' && (
        <ul className="list-disc space-y-1 pl-6 text-slate-700">
          {item.checks.map((check) => (
            <li key={check.name} className="break-words">
              {check.name}: {check.message}
            </li>
          ))}
        </ul>
      )}
      {item.type === 'daemon_incompatible' && (
        <>
          <Command command={item.updateCommand} label="Update command" />
          <Command command={RESTART_COMMAND} label="Restart command" />
        </>
      )}
      {(item.type === 'claude_code_unsupported' || item.type === 'machine_problem') && (
        <Command command={RESTART_COMMAND} label="Restart command" />
      )}
      <div className="flex flex-wrap gap-4">
        {item.type === 'no_claude_account' ? (
          <>
            <Link to="/machines" className="text-blue-700 underline">
              Open Machines
            </Link>
            <HelpLink page="machines#add-a-claude-account">How to add it</HelpLink>
          </>
        ) : item.type === 'no_machine' ? (
          <>
            <Link to="/machines/new" className="text-blue-700 underline">
              Add machine
            </Link>
            <HelpLink page="machines#add-a-machine">How to add a machine</HelpLink>
          </>
        ) : (
          <>
            <Link to={`/machines/${item.machine.id}`} className="text-blue-700 underline">
              Open the machine
            </Link>
            <HelpLink page="machines#when-a-machine-has-a-problem">What to do</HelpLink>
          </>
        )}
      </div>
    </Card>
  );
}

/** Home page: everything waiting for the owner (02, section 4). */
export function NeedsYouPage() {
  const github = useGitHubStatus();
  const needsYou = useNeedsYou();
  if (github.isPending || needsYou.isPending) return <Loading />;
  const problems = github.data?.connected ? github.data.problems : [];
  const items = needsYou.data?.items ?? [];

  return (
    <>
      <PageHeader title="Needs you" help="needs-you" />
      {needsYou.isError && (
        <p role="alert" className="mb-3 text-red-800">
          Some items could not be loaded. Reload the page.
        </p>
      )}
      {problems.length === 0 && items.length === 0 ? (
        <Card>
          <p>Nothing needs you right now.</p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {problems.map((problem, index) => {
            const { title, detail } = problemText(problem);
            return (
              <li key={`${problem.type}-${String(index)}`}>
                <Card className="space-y-2">
                  <h2 className="font-semibold text-slate-900">{title}</h2>
                  <p className="text-slate-700">{detail}</p>
                  <div className="flex flex-wrap gap-4">
                    <Link to="/settings/github" className="text-blue-700 underline">
                      Open GitHub connection
                    </Link>
                    <HelpLink page="github-token">How to create the token</HelpLink>
                  </div>
                </Card>
              </li>
            );
          })}
          {items.map((item) => (
            <li key={itemKey(item)}>
              {item.type === 'project_setup_failed' ? (
                <Card className="space-y-2">
                  <h2 className="font-semibold break-words text-slate-900">
                    Project setup failed: {item.project.key} · {item.project.name}
                  </h2>
                  <p className="break-words text-slate-700">
                    Step “{stepLabel[item.step]}”: {sentence(item.reason)}
                  </p>
                  <div className="flex flex-wrap gap-4">
                    <Link to={`/projects/${item.project.key}`} className="text-blue-700 underline">
                      Open the project
                    </Link>
                    <HelpLink page="projects#if-the-setup-fails">What to do</HelpLink>
                  </div>
                </Card>
              ) : (
                <MachineItemCard item={item} />
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
