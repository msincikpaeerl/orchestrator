import { Link } from 'react-router';
import { Card, HelpLink, Loading, PageHeader } from '../components/ui';
import { problemText } from '../github/text';
import { useGitHubStatus } from '../queries';

/** Home page: everything waiting for the owner (02, section 4). Only GitHub problems so far. */
export function NeedsYouPage() {
  const github = useGitHubStatus();
  if (github.isPending) return <Loading />;
  const problems = github.data?.connected ? github.data.problems : [];

  return (
    <>
      <PageHeader title="Needs you" help="needs-you" />
      {problems.length === 0 ? (
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
        </ul>
      )}
    </>
  );
}
