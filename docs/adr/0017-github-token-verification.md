# 0017 — GitHub token verification by probing

- Status: superseded by 0022
- Date: 2026-09-23

## Context

The owner connects GitHub with a fine-grained personal access token (02, section 3.1). The wizard must tell them which required permissions the token has. GitHub's documentation (checked 2026-09-23) offers no endpoint listing a fine-grained token's permissions, and its expiry date is only available through the `GitHub-Authentication-Token-Expiration` response header, which the current documentation does not describe and which was reported in 2025 to return the request time for fine-grained tokens. The owner does not allow creating or changing anything on GitHub to test the token.

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
| Workflows | `PUT /repos/{owner}/{repo}/contents/.github/workflows/orchestrator-token-check.yml` with `{}` | 422 | 403, unless Contents is not OK |

- Read probes need a **private** repository: every token can read public repositories, so a public one proves nothing. Write probes use a private repository when there is one, otherwise a public one.
- A 403 counts as Missing only when GitHub says the resource is "not accessible" by the token, or when `X-Accepted-GitHub-Permissions` names the probed permission. When that header names other permissions only, the result is Could not verify. Rate limits, 404, 409 (empty repository), 5xx, timeouts, network errors and unexpected answers (including a success on a write probe) give Could not verify. No repository to test on also gives Could not verify.
- The write probes' bodies are invalid, so GitHub cannot act on them.
- The check is a convenience. Every GitHub request made with the stored token goes through one client that records refusals: a 401 marks the token invalid, a "not accessible" 403 records the permissions named by `X-Accepted-GitHub-Permissions` (or the request when the header is absent). Both appear in "Needs you" (02, section 4) until a new check or a new token clears them.

## Alternatives considered

- Creating and deleting a temporary private repository: certain, but changes the owner's account. Refused by the owner.
- Trusting the owner's checklist without checking: no feedback before the first failure.
- Classic tokens, whose `X-OAuth-Scopes` header lists scopes: grant access to every repository and organization of the user; the spec requires a fine-grained token.

## Consequences

- The write probes rely on GitHub checking permissions before validating the request body. This is not documented: it must be confirmed with a real token in lot 0 step E, removing each write permission in turn. Until then a wrong result is possible; the refusal recorder catches it in normal operation.
- A new GitHub account with no repository gets Could not verify for all repository permissions except Administration.
- If GitHub later offers an endpoint listing a token's permissions, the probes should be replaced by it.
