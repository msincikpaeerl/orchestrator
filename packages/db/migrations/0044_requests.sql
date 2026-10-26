CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"new_project" jsonb,
	"status" text NOT NULL,
	"owner_feedback" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_status" CHECK ("plans"."status" IN ('proposed', 'approved', 'rejected', 'superseded'))
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" integer NOT NULL,
	"project_id" uuid,
	"body" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"stopped" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requests_number_unique" UNIQUE("number"),
	CONSTRAINT "requests_number" CHECK ("requests"."number" >= 1),
	CONSTRAINT "requests_status" CHECK ("requests"."status" IN ('open', 'planning', 'plan_proposed', 'closed')),
	CONSTRAINT "requests_attempt_count" CHECK ("requests"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "comments" ALTER COLUMN "ticket_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "request_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plans_request_id" ON "plans" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE INDEX "requests_project_id" ON "requests" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_request_id" ON "comments" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE INDEX "tickets_plan_id" ON "tickets" USING btree ("plan_id");--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_target" CHECK (("comments"."ticket_id" IS NULL) <> ("comments"."request_id" IS NULL));