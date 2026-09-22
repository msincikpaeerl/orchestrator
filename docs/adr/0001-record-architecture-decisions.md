# 0001 — Record architecture decisions

- Status: accepted
- Date: 2026-09-22

## Context

The Orchestrator is built mostly by AI agents and used by an owner who does not read the code. Technical choices must be understandable later by both, without reconstructing them from the code or from chat history.

## Decision

Every significant technical decision is recorded as an Architecture Decision Record in `docs/adr/`, using `0000-template.md`, numbered in sequence. Significant means: language, framework, database, major library, protocol, storage, deployment, security model, or any deviation from the specs or default stacks. An accepted ADR is never rewritten; a new ADR supersedes it and the old one's status is updated.

## Alternatives considered

- Decisions only in the specs: specs describe what the system does, not why a technology was chosen or what was rejected.
- Decisions in commit messages or pull requests: hard to find and not reviewed as a whole.

## Consequences

- Agents read the ADRs of the area they change before working (CLAUDE.md).
- The Quality agent checks that changes respect accepted ADRs and that new decisions come with one.
- Generated projects follow the same rule (08 — Harness).
