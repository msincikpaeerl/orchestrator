-- Lot 3 step F3: the ticket's pull request as last read, "pull request wanted" since an accepted
-- submission, and the latest failed attempt to open or update it. Rows written before keep null.
ALTER TABLE "tickets" ADD COLUMN "pull_request_number" integer;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "pull_request_url" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "pull_request_state" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "pull_request_head" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "pull_request_wanted_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "pull_request_failure" jsonb;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_pull_request_state" CHECK ("tickets"."pull_request_state" IN ('open', 'closed', 'merged'));