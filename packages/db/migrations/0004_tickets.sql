CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author" text NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comments_kind" CHECK ("comments"."kind" IN ('note', 'question', 'answer', 'review', 'status_change'))
);
--> statement-breakpoint
CREATE TABLE "ticket_dependencies" (
	"project_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"blocked_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_dependencies_ticket_id_blocked_by_id_pk" PRIMARY KEY("ticket_id","blocked_by_id"),
	CONSTRAINT "ticket_dependencies_not_itself" CHECK ("ticket_dependencies"."ticket_id" <> "ticket_dependencies"."blocked_by_id")
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"priority" text NOT NULL,
	"status" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_project_number" UNIQUE("project_id","number"),
	CONSTRAINT "tickets_project_id" UNIQUE("project_id","id"),
	CONSTRAINT "tickets_number" CHECK ("tickets"."number" >= 1),
	CONSTRAINT "tickets_type" CHECK ("tickets"."type" IN ('feature', 'bug', 'chore', 'docs', 'spike')),
	CONSTRAINT "tickets_priority" CHECK ("tickets"."priority" IN ('low', 'normal', 'high')),
	CONSTRAINT "tickets_status" CHECK ("tickets"."status" IN ('proposed', 'todo', 'in_progress', 'waiting_human', 'in_review', 'awaiting_merge', 'done', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "last_ticket_number" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_dependencies" ADD CONSTRAINT "ticket_dependencies_ticket" FOREIGN KEY ("project_id","ticket_id") REFERENCES "public"."tickets"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_dependencies" ADD CONSTRAINT "ticket_dependencies_blocked_by" FOREIGN KEY ("project_id","blocked_by_id") REFERENCES "public"."tickets"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_ticket_id" ON "comments" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "ticket_dependencies_blocked_by_id" ON "ticket_dependencies" USING btree ("blocked_by_id");