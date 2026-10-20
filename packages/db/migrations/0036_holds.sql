ALTER TABLE "machines" ADD COLUMN "connected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "held" jsonb;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "machine_failures" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Tickets stopped before lot 4 step D2b stay held as step D2a read them from the runs' history
-- (07, section 2): a ticket in To do whose latest builder run the owner stopped, and a ticket in
-- review whose latest review run the owner stopped (held for the commit that run reviewed).
WITH "latest" AS (
  SELECT DISTINCT ON ("r"."ticket_id", "r"."purpose" = 'review')
    "r"."id", "r"."ticket_id", "r"."purpose", "r"."ended_at", "r"."review_commit"
  FROM "runs" "r"
  WHERE "r"."ticket_id" IS NOT NULL
  ORDER BY "r"."ticket_id", "r"."purpose" = 'review', "r"."created_at" DESC
)
UPDATE "tickets" SET "held" = jsonb_build_object(
  'cause', CASE WHEN "latest"."purpose" = 'review' THEN 'stop_review' ELSE 'stop_run' END,
  'at', to_char("latest"."ended_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'runId', "latest"."id",
  'commit', CASE WHEN "latest"."purpose" = 'review' THEN "latest"."review_commit" END
)
FROM "latest"
WHERE "latest"."ticket_id" = "tickets"."id"
  AND "latest"."ended_at" IS NOT NULL
  AND (
    ("tickets"."status" = 'todo' AND "latest"."purpose" <> 'review')
    OR ("tickets"."status" = 'in_review' AND "latest"."purpose" = 'review' AND "latest"."review_commit" IS NOT NULL)
  )
  AND EXISTS (
    SELECT 1 FROM "events" "e"
    WHERE "e"."entity_type" = 'run' AND "e"."entity_id" = "latest"."id"::text
      AND "e"."type" = 'run.status_changed'
      AND "e"."payload"->>'to' IN ('cancelled', 'failed')
      AND "e"."payload"->>'cause' = 'owner_stopped'
  );
