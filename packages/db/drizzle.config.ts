import { defineConfig } from 'drizzle-kit';

// Used by `pnpm --filter db migrate:generate` only; migrations are applied by `runMigrations`.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
});
