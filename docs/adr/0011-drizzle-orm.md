# 0011 — Drizzle ORM with SQL migrations

- Status: accepted
- Date: 2026-09-23

## Context

09, section 3 chooses Drizzle ORM with SQL migrations kept in the repository. Migrations run when the server starts (09, section 7.1).

## Decision

- The schema is written in TypeScript in `packages/db/src/schema.ts`.
- `pnpm --filter db migrate:generate` runs drizzle-kit to write a new SQL migration into `packages/db/migrations/`. Migrations are reviewed and committed; they may be edited by hand (for example to insert rows), with a comment saying so.
- `runMigrations(pool)` applies pending migrations with Drizzle's migrator. The server calls it before listening and refuses to start if it fails.
- The driver is node-postgres (`pg`): the most used PostgreSQL driver on Node.js, supported by Drizzle and its migrator.
- drizzle-kit's metadata files (`migrations/meta/`) are not formatted by Prettier.

## Alternatives considered

- Prisma: its own schema language and a generated client; migrations are SQL too, but the engine and code generation add weight.
- Kysely with hand-written migrations: good typing, but no migration generation from the schema.
- postgres.js driver: fast, but `pg` is better known and has the wider tool support.

## Consequences

- Migrations are forward only; a mistake is fixed by a new migration.
- Drizzle is not yet 1.0; upgrades are checked against the migration tests in `packages/db/test/`.
