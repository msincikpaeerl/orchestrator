ALTER TABLE "projects" ADD COLUMN "pull_request_watch_failure" jsonb;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "pull_request_closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "pull_request_closed_by" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "pull_request_close_wanted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "pull_request_close_failure" jsonb;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "pull_request_reopen_failure" jsonb;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_pull_request_closed_by" CHECK ("tickets"."pull_request_closed_by" IN ('github', 'orchestrator'));--> statement-breakpoint
-- Every pull request closed before this version was found closed on GitHub (lot 3 step J1).
UPDATE "tickets" SET "pull_request_closed_by" = 'github' WHERE "pull_request_state" = 'closed';
