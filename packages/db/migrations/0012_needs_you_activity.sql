ALTER TABLE "claude_accounts" ADD COLUMN "limited_until_estimated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "runs_ended_at" ON "runs" USING btree ("ended_at","id");--> statement-breakpoint
-- A limited account's time is estimated when its latest limit event used the fallback delay.
UPDATE "claude_accounts" SET "limited_until_estimated" = true
WHERE "state" = 'limited' AND (
  SELECT "payload"->>'source' FROM "events"
  WHERE "type" = 'account.limited' AND "entity_id" = "claude_accounts"."id"::text
  ORDER BY "id" DESC LIMIT 1
) = 'fallback';
