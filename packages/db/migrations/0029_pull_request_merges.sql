ALTER TABLE "tickets" ADD COLUMN "pull_request_merged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "pull_request_merged_head" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "pull_request_merged_into" text;