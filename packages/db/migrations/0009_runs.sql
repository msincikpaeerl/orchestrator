CREATE TABLE "daemon_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"machine_id" uuid NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_log_entries" (
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"tool" text,
	"text" text NOT NULL,
	"cut" boolean NOT NULL,
	CONSTRAINT "run_log_entries_run_id_seq_pk" PRIMARY KEY("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"ticket_id" uuid,
	"profile_id" uuid NOT NULL,
	"profile_version" integer NOT NULL,
	"purpose" text NOT NULL,
	"machine_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"status" text NOT NULL,
	"pause_reason" text,
	"failure_reason" text,
	"end_reason" text,
	"end_detail" text,
	"attempt" integer NOT NULL,
	"run_token_hash" text NOT NULL,
	"run_token_revoked_at" timestamp with time zone,
	"dispatch_message_id" uuid,
	"dispatch_kind" text,
	"ack_deadline" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"claude_session_id" text,
	"session_alive" boolean DEFAULT false NOT NULL,
	"branch_name" text NOT NULL,
	"base_branch" text NOT NULL,
	"branch_head" text,
	"commits" jsonb,
	"estimated_usage_usd" double precision,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_run_token_hash_unique" UNIQUE("run_token_hash"),
	CONSTRAINT "runs_status" CHECK ("runs"."status" IN ('queued', 'dispatched', 'starting', 'running', 'waiting_human', 'paused_quota', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "runs_purpose" CHECK ("runs"."purpose" IN ('implement', 'review', 'plan', 'document', 'fix_review')),
	CONSTRAINT "runs_pause_reason" CHECK ("runs"."pause_reason" IN ('usage_limit', 'suspected_usage_limit')),
	CONSTRAINT "runs_failure_reason" CHECK ("runs"."failure_reason" IN ('timeout', 'crash', 'agent_gave_up', 'dod_failed', 'machine_offline', 'machine_revoked', 'claude_code_unsupported', 'cancelled')),
	CONSTRAINT "runs_attempt" CHECK ("runs"."attempt" >= 1)
);
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "branch_name" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daemon_messages" ADD CONSTRAINT "daemon_messages_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_log_entries" ADD CONSTRAINT "run_log_entries_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_profile_id_agent_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."agent_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_account_id_claude_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."claude_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_active_per_ticket" ON "runs" USING btree ("ticket_id") WHERE "runs"."status" IN ('queued', 'dispatched', 'starting', 'running', 'waiting_human', 'paused_quota');--> statement-breakpoint
CREATE INDEX "runs_ticket_id" ON "runs" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_machine_id" ON "runs" USING btree ("machine_id","status");--> statement-breakpoint
CREATE INDEX "runs_account_id" ON "runs" USING btree ("account_id","status");--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_attempt_count" CHECK ("tickets"."attempt_count" >= 0);