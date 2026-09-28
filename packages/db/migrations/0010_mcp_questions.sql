ALTER TABLE "comments" ADD COLUMN "author_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "answers_comment_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "max_agent_tickets" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "decision" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "progress" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "progress_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "progress_shown" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "progress_shown_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "answer_input_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "created_by_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "created_by_run_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "dod_report" jsonb;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_profile_id_agent_profiles_id_fk" FOREIGN KEY ("author_profile_id") REFERENCES "public"."agent_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_created_by_profile_id_agent_profiles_id_fk" FOREIGN KEY ("created_by_profile_id") REFERENCES "public"."agent_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tickets_created_by_run_id" ON "tickets" USING btree ("created_by_run_id");--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author" CHECK ("comments"."author" IN ('owner', 'system', 'agent'));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_decision" CHECK ("runs"."decision" IN ('submitted', 'gave_up'));--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_created_by" CHECK ("tickets"."created_by" IN ('owner', 'agent'));