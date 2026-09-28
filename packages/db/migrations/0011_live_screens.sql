ALTER TABLE "runs" ADD COLUMN "working_ms" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "waiting_ms" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "status_since" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- A run's current status began at its last change at the latest (01, section 3.7).
UPDATE "runs" SET "status_since" = "updated_at";--> statement-breakpoint
-- The project setup polling is replaced by the realtime stream (04, section 8): its stored value goes.
DELETE FROM "setting_values" WHERE "name" = 'projectSetupPollSeconds';
