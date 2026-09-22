# 0010 — PostgreSQL database

- Status: accepted
- Date: 2026-09-23

## Context

09, section 3 chooses PostgreSQL: reliable, and advisory locks help the scheduler (07). The Orchestrator runs as Docker Compose on WSL, Unraid or a VPS (09, section 7).

## Decision

- PostgreSQL 18, official image `postgres:18.6-alpine3.24`, pinned by exact tag in `docker/compose.yml`, `docker/compose.dev.yml` and the CI workflow. The three tags are updated together.
- Data lives in a named volume mounted at `/var/lib/postgresql` (the layout of PostgreSQL 18 images).
- Development and integration tests use `docker/compose.dev.yml` on `127.0.0.1:5432`. Each integration test file creates its own throw-away database (`createTestDatabase` in `@orchestrator/db/testing`).

## Alternatives considered

- SQLite: simpler to deploy, but no advisory locks and weaker concurrent writes between the scheduler, API and daemon gateway.
- MySQL or MariaDB: no advantage here, fewer features (for example transactional DDL for migrations).

## Consequences

- A major PostgreSQL upgrade needs a dump and restore; the backup command (09, section 7.3) covers it.
- Integration tests need the development database running (`docs/dev/testing.md`).
