# Working rules

Every session working on a lot of [10 — Delivery Plan](../specs/10-delivery-plan.md) follows these rules. The lot's steps are in its plan, `docs/dev/lot-<N>-plan.md` (for example [lot 1](lot-1-plan.md)); closed plans stay as records ([lot 0](lot-0-plan.md)).

1. **Read first.** Read `CLAUDE.md`, these rules and the current lot's plan before working. Implement **only the next unchecked step**, nothing from later steps.
2. **Current, pinned versions.** Use the current stable version of every tool and library. Check it with `npm view <package> version` (or the official release index for Node.js and Docker images) instead of relying on memory, and pin it: exact versions in `package.json`, lock file committed, image tags pinned in Dockerfiles, compose files and the CI workflow, and CI runners pinned to an OS version (`ubuntu-24.04`, not `ubuntu-latest`).
3. **One ADR per choice.** Every technical choice from [09, section 3](../specs/09-architecture-and-deployment.md#3-technology-choices) gets its own short ADR (next number, copied from `docs/adr/0000-template.md`, status `accepted`) **in the step that introduces it**. The same applies to any other significant choice made along the way (library, test tool, encryption scheme).
4. **Do not invent.** If a spec is wrong, incomplete or contradicts another, stop and ask the owner. If a spec is changed, say so in the summary.
5. **No speculative code.** No feature code beyond what the step needs. Placeholders for later lots stay empty.
6. **Definition of done for a step:**
   - `pnpm verify` and `pnpm test:e2e` pass locally;
   - `docs/dev/` and `CLAUDE.md` are up to date (CLAUDE.md stays under 150 lines);
   - user-facing changes are documented in `docs/user/` and have a `CHANGELOG.md` entry;
   - the step is checked off in the lot's plan;
   - the work is committed on the step's branch, ready for a pull request.
7. **Git.** Work on a branch named `lot<N>/<step letter>-<short-name>` (for example `lot1/b-github-repositories`) created from `main`. Commit with Conventional Commits, small commits with one purpose each. **Never commit to `main` directly and never push.** The owner pushes the branch, opens the pull request, checks CI and merges.
8. **Nothing outside the repository.** Never install software or change anything outside this repository: no global installs, no files in the owner's home folder, no PATH or shell changes. The only exception: Docker may pull images declared in the repository's own files (Dockerfiles, compose files, CI workflow, documented commands), pinned to an exact version. If a tool or version is missing, stop and tell the owner what to install.
9. **Nothing on the owner's GitHub account.** Tests use the local fake GitHub. A session never creates, changes or deletes anything on the real GitHub; checks against the real GitHub are run by the owner, in the lot's final step or when the plan says so.
10. **No real Claude Code session.** A session never starts a real Claude Code session through the daemon or otherwise uses the owner's Claude subscription. Tests use the fake `claude` executable; checks with the real Claude Code are run by the owner, in the lot's final step or when the plan says so.
11. **Summary.** End the session with a short summary: what was done, what the owner should check, what comes next, and that the branch is ready for a pull request.
12. **Pull request text.** At the end of every step, give the owner a pull request title and description ready to paste, both in one Markdown code block:
    - title in Conventional Commits style, for example `feat(auth): owner account and login`;
    - description following `.github/pull_request_template.md`, fully filled in: a summary written for the owner (what changes for the user), the ticket or "none", the acceptance criteria as checked items (the step's "Done when"), the tests added and how they were run, and the documentation checklist with each box checked or marked "not needed" with the reason.
13. **Protocol version.** From the 0.3.0 release on, any change a released daemon cannot understand raises `PROTOCOL_VERSION` in `packages/protocol`, in the same change ([09, section 6](../specs/09-architecture-and-deployment.md#6-versioning-and-compatibility)).
14. **Closing a lot.** The lot's final step prepares its version, 0.(N+1).0 ([10](../specs/10-delivery-plan.md)): the version in every `package.json` (and the `/version` test), a dated `CHANGELOG.md` section with a summary of the lot, README.md's status line, CLAUDE.md's "Current state", and the "(from version …)" labels of that version removed from `docs/user/settings.md`. A label left behind fails `apps/web/src/settings/text.test.ts` by itself once `apps/web/package.json` has the new version; Settings > Limits drops its notes by itself.
