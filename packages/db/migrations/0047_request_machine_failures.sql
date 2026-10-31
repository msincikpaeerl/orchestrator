ALTER TABLE "requests" ADD COLUMN "machine_failures" jsonb DEFAULT '[]'::jsonb NOT NULL;
