ALTER TABLE "runs" ADD COLUMN "push" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "push_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "github_branch_head" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "github_branch_pushed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "github_branch_pushed_by" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "github_branch_commits" jsonb;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "branch_push_failure" jsonb;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_github_branch_pushed_by_machines_id_fk" FOREIGN KEY ("github_branch_pushed_by") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;