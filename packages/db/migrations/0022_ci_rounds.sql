-- Lot 3 step G2b: a run's CI rounds (04, section 3.1). Most CI failures per run as resolved when
-- the run started, each failed result or conflict sent back to the agent (the last one maybe still
-- unanswered, matched by its message id), the machine's latest refusal of a round, and the failure
-- reason ci_cancelled (CI cancelled on GitHub because the branch changed there).
ALTER TABLE "runs" DROP CONSTRAINT "runs_failure_reason";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "max_ci_failures" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "ci_rounds" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "ci_round_message_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "ci_round_refusal" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_failure_reason" CHECK ("runs"."failure_reason" IN ('timeout', 'crash', 'agent_gave_up', 'dod_failed', 'machine_offline', 'machine_revoked', 'claude_code_unsupported', 'machine_problem', 'cancelled', 'ci_failed', 'ci_timeout', 'review_branch_moved', 'push_failed', 'ci_cancelled'));