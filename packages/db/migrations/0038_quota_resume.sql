ALTER TABLE "claude_accounts" ADD COLUMN "quota_wait_minutes" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "daemon_state" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "quota_wait_minutes" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "quota_resume_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "resume_left_out" jsonb;