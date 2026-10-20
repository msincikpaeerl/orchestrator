ALTER TABLE "runs" ADD COLUMN "waiting_owner_ms" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "waiting_ci_ms" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "waiting_quota_ms" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
-- A run of an earlier version (lot 4 step H): its time waiting for the owner and for the quota from
-- its periods in `waiting_human` and `paused_quota`, each ended by its next `run.status_changed`
-- event (a period still going on is not in `waiting_ms` yet); the rest of `waiting_ms` is the time
-- its session waited for CI, the only other waiting time (01, section 3.7).
WITH "periods" AS (
  SELECT "entity_id", "payload"->>'to' AS "status",
    lead("created_at") OVER (PARTITION BY "entity_id" ORDER BY "created_at", "id") - "created_at" AS "spent"
  FROM "events"
  WHERE "entity_type" = 'run' AND "type" = 'run.status_changed'
), "totals" AS (
  SELECT "entity_id",
    coalesce(sum(extract(epoch FROM "spent") * 1000) FILTER (WHERE "status" = 'waiting_human'), 0)::bigint AS "owner_ms",
    coalesce(sum(extract(epoch FROM "spent") * 1000) FILTER (WHERE "status" = 'paused_quota'), 0)::bigint AS "quota_ms"
  FROM "periods" WHERE "spent" IS NOT NULL
  GROUP BY "entity_id"
)
UPDATE "runs" SET
  "waiting_owner_ms" = least("totals"."owner_ms", "runs"."waiting_ms"),
  "waiting_quota_ms" = least("totals"."quota_ms", "runs"."waiting_ms" - least("totals"."owner_ms", "runs"."waiting_ms"))
FROM "totals" WHERE "totals"."entity_id" = "runs"."id"::text AND "runs"."waiting_ms" > 0;--> statement-breakpoint
UPDATE "runs" SET "waiting_ci_ms" = "waiting_ms" - "waiting_owner_ms" - "waiting_quota_ms" WHERE "waiting_ms" > 0;
