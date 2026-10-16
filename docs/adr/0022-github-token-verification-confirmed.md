# 0022 — GitHub token verification by probing, confirmed with the real GitHub

- Status: accepted
- Date: 2026-09-23
- Supersedes: 0017

## Context

The owner connects GitHub with a fine-grained personal access token (02, section 3.1). The wizard and Settings must tell them which required permissions the token has. GitHub's documentation (checked 2026-09-23) offers no endpoint listing a fine-grained token's permissions, and its expiry date is only available through the `GitHub-Authentication-Token-Expiration` response header, which the current documentation does not describe and which was reported in 2025 to return the request time for fine-grained tokens. The owner does not allow creating or changing anything on GitHub to test the token.

ADR 0017 chose to probe permissions with requests GitHub must refuse, relying on an undocumented behaviour: GitHub checks permissions before validating the request body. Lot 0 step E tested this with the owner's real token, removing one write permission at a time and running "Check again":

| Token change | Result shown | Correct |
|---|---|---|
| Administration removed | only Administration Missing | yes |
| Pull requests removed | only Pull requests Missing | yes |
| Workflows removed | only Workflows Missing | yes |
| Contents set to read-only | Contents Missing, and Workflows Missing too | no: Workflows was granted |

So the invalid-request approach works, with one exception: writing a file under `.github/workflows/` needs Contents write before GitHub looks at Workflows, and the refusal then also names Workflows. This ADR restates the whole decision with that rule.

## Decision

- The expiry date is entered by the owner (or "No expiry date"). The header only pre-fills the field, when it gives a date in the future and at most 366 days ahead (GitHub's maximum).
- Tokens not starting with `github_pat_` (classic tokens) are refused.
- Permissions are checked by probing, in this order, with the stored token or the token being saved:

| Permission | Request | OK | Missing |
|---|---|---|---|
| (token valid) | `GET /user` | 200: account name | 401: token invalid, nothing else is checked |
| Metadata | `GET /user/repos?affiliation=owner&per_page=100` | a private repository is listed (it is then used by the probes below; non-archived first) | never: no private repository listed gives Could not verify, since a token without Metadata and an account without private repositories look the same |
| Actions | `GET /repos/{owner}/{repo}/actions/runs?per_page=1` (private repository) | 200 | 403 |
| Commit statuses | `GET /repos/{owner}/{repo}/commits/{default branch}/status` (private repository) | 200 | 403 |
| Administration | `POST /user/repos` with `{"name": ""}` | 422 | 403 |
| Contents | `PUT /repos/{owner}/{repo}/contents/.orchestrator-token-check` with `{}` | 422 | 403 |
| Pull requests | `POST /repos/{owner}/{repo}/pulls` with `{}` | 422 | 403 |
| Workflows | `PUT /repos/{owner}/{repo}/contents/.github/workflows/orchestrator-token-check.yml` with `{}`, only when Contents is OK | 422 | 403 |

- **Dependency rule.** A probe that GitHub refuses when another permission is missing, before looking at the probed one, is sent only when that other permission is OK. Otherwise the result is Could not verify, with the reason "Requires Contents (Read and write) first" (or "..., which could not be verified" when that permission is itself Could not verify). It is never Missing: such a refusal, `X-Accepted-GitHub-Permissions` header included, says nothing about the probed permission. Today the only dependency is Workflows on Contents (`PROBE_REQUIRES` in `apps/server/src/github/token-check.ts`).
- Read probes need a **private** repository: every token can read public repositories, so a public one proves nothing. Write probes use a private repository when there is one, otherwise a public one. *Amended in lot 3 step K1*: they use a project's repository first (02, section 3.2), and a refusal on a public repository chosen without a project is Could not verify, since GitHub lists public repositories outside a fine-grained token's selected ones and refuses every write there as "not accessible".
- A 403 counts as Missing only when GitHub says the resource is "not accessible" by the token, or when `X-Accepted-GitHub-Permissions` names the probed permission. When that header names other permissions only, the result is Could not verify. Rate limits, 404, 409 (empty repository), 5xx, timeouts, network errors and unexpected answers (including a success on a write probe) give Could not verify. No repository to test on also gives Could not verify.
- The write probes' bodies are invalid, so GitHub cannot act on them.
- The check is a convenience. Every GitHub request made with the stored token goes through one client that records refusals: a 401 marks the token invalid, a "not accessible" 403 records the permissions named by `X-Accepted-GitHub-Permissions` (or the request when the header is absent). Both appear in "Needs you" (02, section 4) until a new check or a new token clears them.

## Alternatives considered

- Creating and deleting a temporary private repository: certain, but changes the owner's account. Refused by the owner.
- Trusting the owner's checklist without checking: no feedback before the first failure.
- Classic tokens, whose `X-OAuth-Scopes` header lists scopes: grant access to every repository and organization of the user; the spec requires a fine-grained token.
- Keeping the Workflows probe when Contents is missing and trusting the header: the step E test shows the header names Workflows even when it is granted.

## Consequences

- The write probes still rely on undocumented GitHub behaviour, now confirmed for Administration, Contents, Pull requests and Workflows (2026-09-23). If GitHub changes it, results may become wrong; the refusal recorder catches real refusals in normal operation.
- The read probes (Actions, Commit statuses) were not tested by removing each permission with the real GitHub; they use documented read endpoints answering 403 without the permission.
- A token without Contents write always shows Workflows as Could not verify; once Contents is fixed, "Check again" gives Workflows' real result.
- A new GitHub account with no repository gets Could not verify for all repository permissions except Administration.
- A new probe with the same kind of dependency must be added to `PROBE_REQUIRES`, with a test.
- If GitHub later offers an endpoint listing a token's permissions, the probes should be replaced by it.
