# 0031 — Fast throw-away test databases

- Status: accepted
- Date: 2026-09-29

## Context

ADR 0010 runs the integration tests on the development PostgreSQL (`docker/compose.dev.yml`, `127.0.0.1:5432`), and each test file creates an empty database, migrates it and drops it. In lot 2 step L1 this took 312 s of the 692 s spent in test files; the CI `test` job took 9 minutes of its 15-minute timeout (ADR 0030).

Measured locally on 2026-09-29, whole suite, same method as in L1 (the time of each create, migration and drop, added up over about 360 databases):

| | Wall time | Time in test files | Create | Migrations | Drop | Agent seeding |
|---|---|---|---|---|---|---|
| Before | 71 s | 770 s | 73 s | 99 s | 231 s | 9 s |
| Test PostgreSQL settings only | 47 s | 538 s | 15 s | 101 s | 14 s | 7 s |
| Settings and template | 45 s | 453 s | 18 s | 1 s | 15 s | 17 s |

## Decision

- The tests use their own PostgreSQL, service `postgres-test` of `docker/compose.dev.yml` on `127.0.0.1:5433` (the default of `createTestDatabase`, `TEST_DATABASE_URL` still overrides it), with `fsync=off`, `synchronous_commit=off` and `full_page_writes=off`. A crash can corrupt its data, which only throw-away databases hold. The development PostgreSQL keeps safe settings, and `docker/compose.yml` never gets these. CI's `test` job starts the same service with the same command.
- `createTestDatabase()` copies a template database, `test_template_<first 12 digits of the SHA-256 of the migration files>`, with `CREATE DATABASE … TEMPLATE`. The first test process that needs it builds it under a PostgreSQL advisory lock: created under a `_building` name, migrated, renamed, then marked as a template that accepts no connection (copying requires that). Each process checks it once. Templates of other migration files and interrupted builds are dropped at that check. `createTestDatabase({ empty: true })` gives an empty database, for tests of the migrations themselves.
- The default agent profiles are not part of the template: seeding them belongs to the server application, not to `@orchestrator/db`, and costs about 4 % of the test file time.

## Alternatives considered

- Changing the settings of the development PostgreSQL: it holds the data of `pnpm dev`, which a crash could then corrupt.
- Keeping the test data in memory (`tmpfs`): its write-ahead log could grow to about 1 GB of memory, while the settings already remove most disk waits.
- One database per Vitest worker, emptied between test files: faster still, but tests would no longer be isolated by construction, and emptying must follow every schema change.
- Skipping drops in CI: after the settings, drops cost 15 s in total.

## Consequences

- `docker compose -f docker/compose.dev.yml up -d --wait` starts both servers; the tests fail with that command if the test server is not running.
- A new migration builds a new template once; the old one is dropped by the next run.
- Two test runs with different migration files (two checkouts) cannot share the test server at the same time: the second one drops the first one's template.
- The e2e job in CI keeps its PostgreSQL service with the default settings: it creates one database per run.
