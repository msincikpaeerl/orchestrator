-- Lot 3 step G1a: a run's wait for the CI result of its accepted submission (04, section 3.1).
-- The commit pushed at the submission, the two waits as resolved when the run started, when the
-- wait began (the pull request open) and when the session went idle (time counted as waiting),
-- the latest result read and the latest failed check. Earlier runs keep null: they never waited.
ALTER TABLE "runs" ADD COLUMN "ci_commit" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "ci_start_wait_minutes" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "ci_wait_timeout_minutes" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "ci_wait_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "ci_waiting_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "ci_result" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "ci_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "ci_check_failure" jsonb;