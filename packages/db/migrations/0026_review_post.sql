ALTER TABLE "runs" ADD COLUMN "review_post_wanted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "review_post_pull_request" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "review_post_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "review_post" jsonb;