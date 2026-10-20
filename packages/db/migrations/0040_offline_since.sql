ALTER TABLE "machines" ADD COLUMN "offline_since" timestamp with time zone;--> statement-breakpoint
-- A machine offline before this version: since its latest `machine.offline` event, else since its
-- row last changed (lot 4 step G).
UPDATE "machines" SET "offline_since" = COALESCE(
  (SELECT max("events"."created_at") FROM "events"
    WHERE "events"."entity_type" = 'machine' AND "events"."entity_id" = "machines"."id"::text
      AND "events"."type" = 'machine.offline'),
  "machines"."updated_at"
) WHERE "machines"."status" = 'offline';
