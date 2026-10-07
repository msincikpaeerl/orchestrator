# 0033 — Fake GitHub on real Git repositories

- Status: accepted
- Date: 2026-10-05

## Context

From lot 3 the daemon pushes ticket branches, and the server reads what was pushed: pull requests, mergeability, the Actions runs of the head commit, conflicts with the base branch. Lot 3's decision Q26 asks for one fake joining REST and Git, so that a push is seen by the REST API. Until lot 2, the fake kept commits and trees in memory (made-up hashes), and Git tests used a separate `git http-backend` server with one fixed credential. Tests never reach the real GitHub (working rule 9), and the fake is only worth what it has in common with GitHub.

## Decision

Each repository of the fake GitHub (`apps/server/test/fake-github.ts`) is a bare Git repository on disk, in a folder of the fake under `/tmp/od-test-github-*` removed when it closes. The REST API writes and reads it with Git plumbing commands (`hash-object`, `write-tree`, `commit-tree`, `update-ref`, `merge-tree`), with no user or system Git configuration. Git over HTTP is `git http-backend` behind the handler of `@orchestrator/daemon/testing/git-http-server`, mounted on the fake's own address, with the REST API's token check; a proc-receive hook refuses workflow changes without the Workflows permission (a pre-receive hook until lot 3 step E3, which could not give GitHub's refusal text as the rejected reason). Every behaviour is taken from GitHub's documentation for the API version the server pins and cited in the code; what the documentation does not say is listed for the owner's check of the real GitHub (lot 3 plan, step E).

A guard makes a test that tries to reach the real GitHub fail: `fetch` refuses github.com in every test file (`vitest.setup.ts`), and test homes' Git configuration sends github.com URLs to a closed local port.

## Alternatives considered

- **Keep the in-memory store and add a Git server beside it**: two copies of each repository to keep in step, and made-up hashes Git cannot use.
- **Translate pushes into the in-memory store** (parse the pack Git sends): reimplements Git; mergeability and conflicts would be guesses.
- **A Git hosting server in Docker** (Gitea, Forgejo): a GitHub-like API, but not GitHub's answers, refusals or permissions, a heavy service for every test run, and a new image to pin.

## Consequences

- Commits, merges, conflicts, fast-forwards and **Update branch** behave as Git does; hashes are real.
- Tests and the end-to-end server need `git` with `git http-backend` (and `git merge-tree --write-tree`, Git 2.38 or later; the proc-receive hook needs 2.29) on the host and in the Playwright image (2.43 there).
- Each repository costs a folder and a few Git commands; a test's repositories are removed with the fake.
- A difference between the fake and GitHub found by the owner's smoke script is fixed in the fake, with a test.
