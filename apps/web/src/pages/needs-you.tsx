import { Link } from 'react-router';
import { Card, HelpLink, Loading, PageHeader } from '../components/ui';
import { problemText } from '../github/text';
import { sentence, stepLabel } from '../projects/text';
import { useGitHubStatus, useNeedsYou } from '../queries';

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
            <li key={`${item.type}-${item.project.key}`}>
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
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
