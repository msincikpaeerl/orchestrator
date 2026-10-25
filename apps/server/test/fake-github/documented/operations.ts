// The REST answers with a body the fake GitHub gives, whose documented shape extract.ts takes from
// GitHub's OpenAPI description into github-rest.json: `<METHOD> <path>` as GitHub's documentation
// writes the path, and the status. Add a line here, then run extract.ts, for a new answer.

/** Every answer with a body the fake GitHub gives on success: `<METHOD> <path>` and the status. */
export const OPERATIONS: [string, string][] = [
  ['GET /user', '200'],
  ['GET /user/repos', '200'],
  ['POST /user/repos', '201'],
  ['GET /repos/{owner}/{repo}', '200'],
  ['PUT /repos/{owner}/{repo}/contents/{path}', '201'],
  ['GET /repos/{owner}/{repo}/git/ref/{ref}', '200'],
  ['PATCH /repos/{owner}/{repo}/git/refs/{ref}', '200'],
  ['GET /repos/{owner}/{repo}/git/commits/{commit_sha}', '200'],
  ['POST /repos/{owner}/{repo}/git/commits', '201'],
  ['GET /repos/{owner}/{repo}/git/trees/{tree_sha}', '200'],
  ['POST /repos/{owner}/{repo}/git/trees', '201'],
  ['GET /repos/{owner}/{repo}/rulesets', '200'],
  ['POST /repos/{owner}/{repo}/rulesets', '201'],
  ['GET /repos/{owner}/{repo}/pulls', '200'],
  ['POST /repos/{owner}/{repo}/pulls', '201'],
  ['GET /repos/{owner}/{repo}/pulls/{pull_number}', '200'],
  ['PATCH /repos/{owner}/{repo}/pulls/{pull_number}', '200'],
  ['GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', '200'],
  ['POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews', '200'],
  ['PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch', '202'],
  ['PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', '200'],
  ['GET /repos/{owner}/{repo}/actions/runs', '200'],
  ['GET /repos/{owner}/{repo}/actions/runs/{run_id}', '200'],
  ['GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs', '200'],
  ['GET /repos/{owner}/{repo}/actions/jobs/{job_id}', '200'],
  ['GET /repos/{owner}/{repo}/commits/{ref}/status', '200'],
  ['GET /repos/{owner}/{repo}/commits/{ref}/statuses', '200'],
  ['GET /repos/{owner}/{repo}/compare/{basehead}', '200'],
  // Refusals the Orchestrator or the owner's smoke script reads, where GitHub documents them:
  // the 422 bodies, and the 403 for a missing permission (GitHub documents none for the runs
  // and the status of a commit; there the fake answers the same "basic-error").
  ['POST /repos/{owner}/{repo}/pulls', '422'],
  ['POST /repos/{owner}/{repo}/pulls', '403'],
  ['PATCH /repos/{owner}/{repo}/pulls/{pull_number}', '422'],
  ['POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews', '422'],
  ['POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews', '403'],
  ['PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch', '422'],
  // The merge's refusals (lot 5 step 5bis B): not mergeable, head changed, invalid, forbidden.
  ['PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', '405'],
  ['PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', '409'],
  ['PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', '422'],
  ['PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', '403'],
];
