# 0001 — Record architecture decisions

- Status: accepted
- Date: {{date}}

## Context

{{name}} is built mostly by AI agents and used by an owner who does not read the code. Technical choices must be understandable later by both, without reconstructing them from the code or from chat history.

## Decision

Every significant technical decision is recorded as an Architecture Decision Record in `docs/adr/`, using [`0000-template.md`](0000-template.md), numbered in sequence. Significant means: language, framework, database, major library, test tool, deployment, or any deviation from the default stack. An accepted ADR is never rewritten; a new ADR supersedes it and the old one's status is updated.

## Alternatives considered

- Decisions only in the documentation: it describes what the project does, not why a technology was chosen or what was rejected.
- Decisions in commit messages or pull requests: hard to find and not reviewed as a whole.

## Consequences

- Agents read the ADRs of the area they change before working (`CLAUDE.md`).
- Reviews check that changes respect accepted ADRs and that new decisions come with one.
