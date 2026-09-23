# 0023 — Project skeleton and repository setup through the GitHub API

- Status: accepted
- Date: 2026-09-23

## Context

A project with a new repository gets the common skeleton in one commit and, when the owner's GitHub plan allows it, a protected default branch (08, section 3.1). A linked repository is only read, to list its missing harness elements (08, section 3.4). The server runs in one container without Git installed (ADR 0014), and every GitHub request goes through the stored-token client, which records refusals (ADR 0022). The GitHub documentation check of lot 1 step A found that the Git database API answers 409 on an empty repository, and that GitHub Free offers branch protection and rulesets on public repositories only.

## Decision

- **Skeleton files** live in `templates/project-skeleton/`, a workspace package (`@orchestrator/templates`) that the server depends on, so `pnpm deploy` puts them in the image, as for the UI (ADR 0018). Placeholders `{{name}}`, `{{description}}`, `{{defaultBranch}}` (the CI's `push` branch) and `{{date}}` (ADR 0001's date) are filled in one pass; values in YAML files are escaped for single quotes.
- **Skeleton commit** through the REST API, no Git clone: the repository is created with `auto_init` (GitHub's README commit); then `POST /git/trees` with every file inline and `base_tree` set to the head's tree, `POST /git/commits` with the head as parent, and `PATCH /git/refs/heads/{default branch}` with `force: false`. An empty repository first gets the skeleton's README with `PUT /contents/README.md`. The default branch comes from GitHub's answer.
- **Retry**: applying the skeleton again is safe. When the new tree equals the head's tree, the skeleton is already there and nothing is committed; otherwise the commit follows the current head. The history always ends with GitHub's first commit and one skeleton commit.
- **Branch protection** with a **repository ruleset** named "Orchestrator: protect the default branch" (`~DEFAULT_BRANCH`, pull request required with no approval, the check `ci` required). A ruleset of that name already present counts as applied. A 403 whose message asks to upgrade to GitHub Pro or make the repository public gives `not_available`; any other refusal gives `failed` with the reason.
- **One required check, `ci`.** A ruleset requires checks by job name. The skeleton's CI ends with a job named `ci` that needs every other job, runs even when one of them fails (`if: always()`), and fails when any of them failed, was cancelled or was skipped. The ruleset requires only `ci`. The skeleton's CLAUDE.md says that every job is listed in the needs of `ci`, and that `ci` is never renamed or removed. A test checks that the ruleset and the skeleton's workflow use the same name.
- **Harness elements** are read from one recursive tree listing of the default branch (`GET /git/trees/{branch}?recursive=1`); 409 means an empty repository, with every element missing.
- **Skeleton CI** installs `remark-cli` and `remark-validate-links`, pinned to this repository's versions, with `npm install --no-save --no-package-lock`, then runs `remark`, so the skeleton needs no `package.json` before the bootstrap ticket chooses the stack. The skeleton's CLAUDE.md gives the same one-line command, word for word, and its `.gitignore` ignores the `node_modules/` it creates. (`npx --package` without installing was tried: remark then cannot find its plugin.) Tests keep the versions and Node.js in step with this repository, keep CLAUDE.md's command identical to the CI's, and run the check on the rendered skeleton.
- Failures are `GitHubOperationError`, whose message is written for the owner ("Could not create the repository shop: ...") and becomes the setup's reason.

## Alternatives considered

- Replacing GitHub's first commit with the skeleton (a forced update of the default branch): one commit instead of two, but a forced update; refused by the owner in step A.
- Creating an empty repository and pushing with Git: needs Git and a credential helper in the server image, and the token on a command line or in a file.
- One `PUT /contents` request per file: one commit per file, against "one commit" in 08.
- Classic branch protection (`PUT /branches/{branch}/protection`): same plan limit, one branch name fixed at creation; rulesets follow the default branch if it is renamed and are GitHub's current feature.
- Requiring each CI job by name (for example the skeleton's `docs-links`): the bootstrap ticket rewrites CI for the project's stack, and a renamed or removed job would leave the ruleset waiting for a check that never comes, so no pull request could be merged.
- Requiring approving reviews: the owner opens pull requests with their own token, and GitHub never lets an author approve their own pull request.

## Consequences

- A setup can be tried again from the failed step without duplicating commits or rulesets.
- The history of a new repository has two commits (GitHub's README, then the skeleton).
- Moving the branch needs Workflows (write) because the skeleton contains `.github/workflows/ci.yml`; the fake GitHub assumes GitHub refuses it with "not accessible" like other missing permissions. The lot 1 check with the real GitHub (step I) confirms the plan refusal message and the ruleset.
- Every CI job of a project must be listed in the needs of `ci`; a job left out is not required for merging. `ci` must keep its name.
- A tree listing truncated by GitHub (over 100,000 entries) could report elements as missing; such repositories are not expected.
