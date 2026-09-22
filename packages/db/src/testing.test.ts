import { expect, it } from 'vitest';
import { createTestDatabase } from './testing.js';

it('explains how to start PostgreSQL when it cannot be reached', async () => {
  await expect(createTestDatabase('postgres://nobody:secret@127.0.0.1:1/none')).rejects.toThrow(
    'Cannot reach PostgreSQL at 127.0.0.1:1 for integration tests. Start it with: ' +
      'docker compose -f docker/compose.dev.yml up -d postgres',
  );
});
