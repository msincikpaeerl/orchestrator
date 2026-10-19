CREATE TABLE "time_zone" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_zone_single_row" CHECK ("time_zone"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "claude_accounts" ADD COLUMN "schedule" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "claude_accounts" ADD COLUMN "daily_budget" jsonb;