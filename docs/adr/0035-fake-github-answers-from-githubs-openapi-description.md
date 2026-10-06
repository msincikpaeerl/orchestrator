# 0035 — The fake GitHub answers GitHub's documented shapes, from its OpenAPI description

- Status: accepted
- Date: 2026-10-06

## Context

The owner's first run of the GitHub smoke script (lot 3 step E2) stopped at step 2: GitHub created the pull request (HTTP 201), but the GitHub layer could not read the answer. REST API version 2026-03-10, the version the server pins, removed `merge_commit_sha` from pull requests; the layer required it. The fake GitHub and the layer had been written together, so the fake answered exactly the fields the layer read, and no test could see the difference. Every behaviour of the fake is cited from GitHub's documentation (ADR 0033), but the shape of each answer (which fields, which may be null, which may be absent) was written by hand.

GitHub publishes its REST API as an OpenAPI description, per API version (https://github.com/github/rest-api-description): the same source as its reference pages, with each field's type, whether it is required and whether it may be null.

## Decision

- `apps/server/test/fake-github/documented/github-rest.json` holds the documented answer of every REST endpoint the fake serves, extracted from GitHub's OpenAPI description for version 2026-03-10 at a pinned commit by `documented/extract.ts` (run by hand, never by the tests; the list of endpoints is `documented/operations.ts`). Only what a shape needs is kept: types, `nullable`, `required`, properties, items, enums and the schemas they reference (about 70 KB).
- The fake writes only the values it models. Before an answer leaves the fake, `shaped` (`fake-github/documented.ts`) completes it: every required field present, a nullable one the fake does not model null, an optional one left out. It then checks the result and refuses a missing field, a wrong type, a null GitHub does not allow, and a field GitHub does not document: the fake answers with an HTTP 500 naming them, which fails the test. An answer with a body whose endpoint is not in the extract is refused the same way.
- `apps/server/test/github-documented.test.ts` gives every reading of the GitHub layer the plainest bodies the description allows (required fields only and every nullable one null; then nullable objects filled and optional fields present), without the fake. Where the layer checks more than the description on purpose, the test says why.
- The layer reads only the fields the Orchestrator uses, each as documented, and a body that does not fit is refused with the fields named, by type, never by value.

## Alternatives considered

- **Write each documented shape by hand in the fake**: what the fake did before; long (a pull request has about 50 fields, with two repositories of about 80 each), and wrong as soon as GitHub changes a version, as this time.
- **Copy GitHub's documented examples as the fake's answers**: examples are not checked by GitHub against the schema, can be out of date (a removed field may stay), and never show a null where a value is usual.
- **Check answers with a JSON Schema library (Ajv)** against the full description: a new dependency, and the 13 MB description, for the few keywords GitHub's answers use; a small checker does it.
- **Read the whole description at test time**: 13 MB loaded by every test file using the fake, and a download in CI.

## Consequences

- A field GitHub removes or makes nullable in the pinned version breaks the fake's tests before it reaches the owner: the shapes come from GitHub, not from the layer's expectations.
- Raising the pinned API version means running `extract.ts` with the new version and commit, then reading the breaking changes for what the fake's behaviour must change.
- A new endpoint served by the fake needs a line in `documented/operations.ts` and a new extract.
- Behaviours (status codes, error texts, ordering, mergeability) are still the fake's, cited from GitHub's documentation (ADR 0033) and checked by the owner's smoke script; the description gives only shapes.
