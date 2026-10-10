-- Lot 3 step G2c: the pull request's head read with the CI result that decided, when it was
-- another commit (shown after ci_cancelled), and the work accepted later by Check CI again.
ALTER TABLE "runs" ADD COLUMN "ci_pull_request_head" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "ci_accepted_later" jsonb;
