CREATE TABLE "branch_clean_ups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"target" text NOT NULL,
	"machine_id" uuid,
	"pull_request_number" integer NOT NULL,
	"branch" text NOT NULL,
	"merged_head" text NOT NULL,
	"merged_into" text NOT NULL,
	"default_branch" text NOT NULL,
	"state" text DEFAULT 'wanted' NOT NULL,
	"reason" jsonb,
	"failure" jsonb,
	"pushed_again" jsonb,
	"tried_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_clean_ups_target" CHECK ("branch_clean_ups"."target" IN ('github', 'machine')),
	CONSTRAINT "branch_clean_ups_machine" CHECK (("branch_clean_ups"."target" = 'machine') = ("branch_clean_ups"."machine_id" IS NOT NULL)),
	CONSTRAINT "branch_clean_ups_state" CHECK ("branch_clean_ups"."state" IN ('wanted', 'deleted', 'already_gone', 'kept'))
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "end_missing_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "branch_clean_ups" ADD CONSTRAINT "branch_clean_ups_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_clean_ups" ADD CONSTRAINT "branch_clean_ups_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "branch_clean_ups_github" ON "branch_clean_ups" USING btree ("ticket_id","pull_request_number") WHERE "branch_clean_ups"."target" = 'github';--> statement-breakpoint
CREATE UNIQUE INDEX "branch_clean_ups_machine_once" ON "branch_clean_ups" USING btree ("ticket_id","pull_request_number","machine_id") WHERE "branch_clean_ups"."target" = 'machine';--> statement-breakpoint
CREATE INDEX "branch_clean_ups_wanted" ON "branch_clean_ups" USING btree ("state","created_at");