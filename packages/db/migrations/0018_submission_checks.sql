-- Lot 3 step F2: each run keeps its accepted submission and its latest refused one, with each
-- check's result (owner's addition). Cost: a DoD report is at most 256 KiB (04, section 8), and
-- the check results a few KiB, so a run row grows by at most about 520 KiB, usually a few KiB;
-- PostgreSQL stores such jsonb values compressed out of line (TOAST). A refusal replaces the
-- previous one (one row update per refused call), so an agent looping on refusals adds nothing.
-- Rows written before this migration keep null: no backfill, nothing rewritten.
ALTER TABLE "runs" ADD COLUMN "submission" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "refused_submission" jsonb;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "dod_checks" jsonb;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "workflow_changes" boolean;