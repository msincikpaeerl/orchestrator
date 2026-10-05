ALTER TABLE "runs" DROP CONSTRAINT "runs_failure_reason";--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "daemon_build" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "daemon_outdated_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "daemon_build_differs_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_failure_reason" CHECK ("runs"."failure_reason" IN ('timeout', 'crash', 'agent_gave_up', 'dod_failed', 'machine_offline', 'machine_revoked', 'claude_code_unsupported', 'machine_problem', 'cancelled', 'ci_failed', 'ci_timeout', 'review_branch_moved'));