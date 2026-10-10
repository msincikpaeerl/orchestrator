ALTER TABLE "runs" ADD COLUMN "review_commit" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "review_decision" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "review_applied_at" timestamp with time zone;