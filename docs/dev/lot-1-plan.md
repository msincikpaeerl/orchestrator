# Lot 1 — Implementation plan

> Status: approved by the owner 2026-09-23
> Scope: "Lot 1 — Projects and tickets" in [10 — Delivery Plan](../specs/10-delivery-plan.md).
> **Lot 1 is done when** the owner can manage a project's tickets entirely from the UI and the repository is created with the skeleton.

Every session follows the [working rules](working-rules.md). Branches: `lot1/<step letter>-<short-name>`.

## Decisions taken for this lot (2026-09-23)

Confirmed by the owner and written into the specs in step A:

- Owner actions on tickets: **Mark as done manually** from `todo`, `in_progress`, `waiting_human`, `in_review` or `awaiting_merge` (not `proposed`), with a mandatory comment; **Reopen** from `cancelled` to `todo` (04, section 2).
- A project has a **new repository** (private by default, public on request, skeleton applied) or a **linked** existing repository of the owner's account (nothing written; missing harness elements listed) (01 section 3.1, 02 section 6.2, 08 sections 3.1 and 3.4).
- Project **key**: 2 to 6 uppercase letters, unique, immutable, ticket number prefix (01, section 3.1).
- **No deletion**: projects are archived (the GitHub repository is never changed), tickets cancelled (01, invariant 7).
- **Markdown** from the owner or agents is rendered sanitized (01 section 3.5, 09 section 5).

From the GitHub documentation check (step A, details in the step A notes below):

- The skeleton is one commit: the repository is created with `auto_init` (GitHub's first commit, a README, is needed because the Git database API answers 409 on an empty repository), then the skeleton commit is made with that commit as its parent and the default branch is moved forward to it, without force. The history has two commits (owner's decision: simpler than replacing GitHub's commit).
- Branch protection uses a **repository ruleset** (pull request required, skeleton CI required). On GitHub Free, rulesets and protected branches exist only for public repositories: GitHub answers 403 "Upgrade to GitHub Pro or make this repository public". This answer gives `not_available`, shown as information; a "Resource not accessible" 403 is a missing permission, recorded as in lot 0 (ADR 0022).
- No new token permission is needed (see the table in the step A notes).

Scope choices for lot 1 (owner's answers, 2026-09-23):

- Ticket fields added in lot 1: number, type, title, description, acceptance criteria, priority, status, dependencies, created by. Assignee comes with agent profiles (lot 2), parent tickets with plans (lot 5), branch, pull request, attempt count and DoD report with runs (lots 2 and 3). Columns are added by the lot that uses them.
- Screens refresh after each action and when the window regains focus; the Server-Sent Events stream (09, section 3) comes in lot 2, when agents change tickets while the owner watches.
- A linked repository gets no branch protection: nothing is written to it in lot 1.
- Archived projects can be unarchived.
- The dependency graph moves to lot 5, with the plan review graph (10 updated). In lot 1 the ticket page lists "Blocked by" and "Blocks", and the board shows a "Blocked" badge.
- Images in Markdown are shown as links, never loaded.
- The two working rules added in step A are confirmed: `pnpm test:e2e` is part of a step's definition of done, and sessions never act on the owner's real GitHub.

## Steps

### [x] A. Plan and spec decisions

- Working rules moved to [working-rules.md](working-rules.md), referenced from CLAUDE.md; the lot 0 plan kept as a closed record.
- Specs 01, 02, 04, 08, 09 and 10 updated with the decisions above.
- GitHub documentation checked for the skeleton commit, branch protection on free accounts and token permissions (notes below).
- This plan.

**Done when** the owner has approved this plan and the spec changes.

*Done 2026-09-23.* The owner approved the plan with changes: the skeleton commit follows GitHub's first commit (no forced update), "Mark as done manually" excludes `proposed`, and the dependency graph moves to lot 5. Answers to the questions are recorded in "Scope choices" above.

**Notes: GitHub documentation check (2026-09-23)**

Skeleton commit:

- The Git database API (blobs, trees, commits, refs) answers `409 Conflict` when the repository is empty; GitHub's guide says to create a first file with `PUT /repos/{owner}/{repo}/contents/{path}`, which works on an empty repository.
- New repository: `POST /user/repos` with `auto_init: true` gives a first commit (a README). Then `POST /git/trees` with every skeleton file inline and `base_tree` set to that commit's tree (the skeleton's README replaces GitHub's), `POST /git/commits` with that commit as parent, and `PATCH /git/refs/heads/{default branch}` without `force`: GitHub accepts it only as a fast-forward. The history has two commits.
- Already empty repository (for example if creation succeeded without GitHub's first commit): one `PUT /contents/README.md` first, then the same three requests.
- The default branch name is read from GitHub's answer (the owner's GitHub setting), not assumed to be `main`.

Branch protection:

- GitHub documents protected branches and rulesets as available "in public repositories with GitHub Free and GitHub Free for organizations, and in public and private repositories with GitHub Pro, GitHub Team, GitHub Enterprise Cloud". So a private repository on a free personal account can have neither.
- On such a repository GitHub answers 403 with "Upgrade to GitHub Pro or make this repository public to enable this feature" (reported by users; the message is not in the reference documentation, so the lot 1 check in step I confirms it with the real GitHub).
- The skeleton step then records `not_available` and the project page says so, as information with a help link (08, section 3.1). Setup still succeeds.

Token permissions used by lot 1, from GitHub's "Permissions required for fine-grained personal access tokens":

| Operation | Request | Permission |
|---|---|---|
| List the owner's repositories to link | `GET /user/repos?affiliation=owner` | Metadata (read) |
| Read a repository; check a name is free | `GET /repos/{owner}/{repo}` | Metadata (read) |
| Create the repository | `POST /user/repos` | Administration (write) |
| First file in an empty repository | `PUT /repos/{owner}/{repo}/contents/README.md` | Contents (write) |
| Skeleton tree and commit | `POST .../git/trees`, `POST .../git/commits` | Contents (write) |
| Move the default branch forward to the skeleton commit | `PATCH .../git/refs/heads/{branch}` | Contents (write), and Workflows (write) because the commit contains `.github/workflows/ci.yml` |
| Branch protection | `POST /repos/{owner}/{repo}/rulesets` | Administration (write) |
| Harness elements of a linked repository | `GET .../git/trees/{branch}?recursive=1` | Contents (read) |
| Tickets, comments, archive, settings, event log | none | none |

Compared with 02, section 3.1: every permission used is already required, with the same level; Pull requests, Commit statuses and Actions are not used before lot 3. Only the "why" column changed (Contents also reads linked repositories; Metadata also lists repositories to link). No change for the owner's existing token.

### [x] B. GitHub repository operations (server, no screens)

- Skeleton files in `templates/project-skeleton/` (layout of 08, section 2, placeholders for the project name and description), bundled into the server image. Its CI runs the documentation link check with pinned versions and needs no `package.json`.
- `apps/server/src/github/`: list the owner's repositories, check a name is free, create the repository (private or public), apply the skeleton as one commit after GitHub's first commit (both paths above, fast-forward only), apply the ruleset (`applied`, `not_available`, `failed`), read the harness elements of a repository (08, section 3.4). All through the stored-token client, so refusals reach "Needs you".
- The local fake GitHub (`apps/server/test/fake-github.ts`) gains these endpoints, including the empty-repository 409, the "Upgrade to GitHub Pro" 403 and the "not accessible" 403.
- ADR: project skeleton and repository setup through the GitHub API (skeleton commit after GitHub's first commit, ruleset rather than classic branch protection).
- `docs/dev/architecture.md` updated.

**Done when** integration tests against the fake GitHub show: a private and a public repository created with two commits (GitHub's README, then the skeleton) and the branch moved without force; the empty-repository path; a setup tried again after a failed skeleton step; the ruleset applied, not available and refused; harness elements found, missing, and all missing on an empty repository; and a test runs the skeleton's own link check on the rendered skeleton successfully.

*Done 2026-09-23.* `apps/server/src/github/repositories.ts` and `skeleton.ts`, ADR 0023; the fake GitHub now keeps commits, trees, branches and rulesets. Choices within the step: `templates/` is a workspace package the server depends on (bundled like the UI); the skeleton also fills in the default branch (for its CI) and the date (ADR 0001), and has a `.remarkrc.json` for its link check; the ruleset requires only the final CI job `ci`, which needs every other job (owner's review; 08, section 4), and no approving review (GitHub never lets the owner approve their own pull request); applying the skeleton or the ruleset again is safe (no duplicate commit or ruleset). The skeleton's CI command was also run in the pinned `node` image: it passes on the skeleton and fails on a broken link. Requests added to the step A table, needing no new permission: `GET .../git/ref/heads/{branch}` and `GET .../git/commits/{sha}` (Contents read) to find the head, `GET .../rulesets` (Metadata read) to find a ruleset left by an earlier attempt.

### [ ] C. Projects: database and API

- Table `projects` (01, section 3.1) with its migration; key rules (2 to 6 uppercase letters, unique including archived projects, immutable); slug from the name.
- API with protocol schemas: list (archived hidden unless asked), detail, create with a new repository, create by linking, repositories available to link, name and key availability, **Try again** for a failed setup, **Check again** for harness elements, archive, unarchive, edit name and description.
- Repository setup runs in the background after the project is saved (`setup_status` `in_progress`, then `ready` or `failed` with the reason); at server start, a setup left `in_progress` becomes `failed` ("interrupted by a restart") so it can be tried again.
- Events for every change (`project.created`, `project.setup_step`, `project.setup_failed`, `project.ready`, `project.archived`, ...). "Needs you" API gains "project setup failed".

**Done when** integration tests cover each endpoint with its refusal cases (bad or duplicate key, repository name taken, repository already linked, archived GitHub repository, GitHub refusal, edit of an archived project), the restart case, and prove archiving sends no request to GitHub.

### [ ] D. Projects: screens and user documentation

- Projects list with "Show archived", new project form with its two ways (02, section 6.2), project page header (setup progress and result, branch protection, missing harness elements with **Check again**, **Try again**), project settings (name, description), archive and unarchive with confirmation. "Needs you" shows failed setups.
- `docs/user/`: a Projects page (create with a new repository, link a repository, what "branch protection not available" means, missing harness elements, archive) and index, getting started and needs-you updated. Every new screen links to its Help page.
- Playwright tests on desktop and phone against the fake GitHub.

**Done when** Playwright covers creating a private project, linking a repository with missing elements, a failed setup tried again, and archiving, on both viewports.

### [ ] E. Tickets: database and API

- Tables `tickets`, `ticket_dependencies`, `comments` with their migration; ticket numbers from a per-project counter, never reused.
- One transition module on the server implementing 04, section 2: owner creation (`todo`), cancel, mark as done manually (mandatory comment posted as `status_change`), reopen. Every other transition refused with an explanation. Edits only in `proposed` and `todo`; no change at all on an archived project or a project that is not `ready`.
- Dependencies: same project, not itself, no cycle (refused naming the cycle); blocked is derived.
- Comments: owner notes on any ticket, including terminal ones.
- API with protocol schemas: board data (tickets per state with blocked flag), detail with timeline (comments and status changes), create, edit, dependencies, comment, cancel, mark as done manually, reopen. Events for every change.

**Done when** integration tests cover every allowed and refused transition of the table, dependency rules including a longer cycle, numbering under concurrent creation, and the archived-project refusal.

### [ ] F. Tickets: screens, sanitized Markdown and user documentation

- Board (02, section 6.3): columns by state, `done` and `cancelled` collapsed, filters by type and text, a "Blocked" badge.
- Create and edit form (type, title, description, ordered acceptance criteria, priority, dependencies); ticket detail (02, section 6.4) with timeline, comment box, "Blocked by" and "Blocks" lists with the dependency editor, and the actions of the ticket's state, with confirmations.
- One Markdown component for untrusted content: react-markdown as in Help, raw HTML not rendered, links limited to `http`, `https`, `mailto`, images shown as links (09, section 5). ADR for this rule (Help keeps ADR 0020).
- `docs/user/`: a Tickets page (create, edit, dependencies, comments, cancel, mark as done manually, reopen, what "blocked" means).
- Playwright tests on both viewports; unit tests feeding script tags, `javascript:` links, event handler attributes and images to the Markdown component.

**Done when** Playwright covers creating tickets with a dependency, commenting, cancelling and reopening, marking as done manually (refused without a comment), on both viewports, and the Markdown tests prove nothing can run.

### [ ] G. Settings screen with limits

- Table for setting values: global values and per-project overrides for the settings marked so in 04, section 8; one function resolving project override, then global value, then default. Existing settings (sessions, login throttling, GitHub token warning and timeout) move to it.
- Each setting described once in `packages/protocol` (name, description, unit, allowed range, default, overridable per project).
- Settings > Limits (02, section 10): value, default, description, **Reset to default**; project settings show the overridable ones. Settings used only by later lots say "Used from version ...". Changes apply to future actions only, and write an event.
- `docs/user/`: a Settings reference page listing every setting with its effect (04, section 8).

**Done when** integration tests cover validation, overrides and reset, a changed login throttling value takes effect without restart, and Playwright changes a global limit and a project override on both viewports.

### [ ] H. Event log

- Events gain a project reference so they can be filtered by project; API listing events with filters (project, ticket, kind of entity, event type, date) and paging.
- Activity > Event log (02, section 7): each event in plain words ("WEB-12 marked as done manually: ..."), with links to the project or ticket. The rest of Activity stays "Coming in a later version".
- `docs/user/`: an Activity page (event log section).

**Done when** integration tests check each lot 0 and lot 1 event type has a plain-words description and filters work, and Playwright filters the log by project on both viewports.

### [ ] I. Lot 1 check by the owner

- Version 0.2.0 prepared (CHANGELOG section, version numbers).
- The owner follows `docs/user/` alone on a clean checkout with the real GitHub:
  1. create a project with a new private repository: on GitHub, the repository has two commits (GitHub's README, then the skeleton), its CI passes, and the project page shows branch protection as applied or "not available on your GitHub plan" as expected for the account;
  2. optionally create a public test repository to confirm the ruleset is applied (the owner deletes it on GitHub afterwards if wanted);
  3. link an existing repository and see its missing harness elements;
  4. create tickets with dependencies, comment, edit, cancel, reopen, mark as done manually;
  5. change a limit, archive and unarchive the project (the GitHub repository is unchanged), read the event log.
- Gaps found are fixed, each with its test; results recorded in this plan.

**Done when** the owner has run the scenario from the user documentation alone and confirmed it, and lot 1 is closed as version 0.2.0.
