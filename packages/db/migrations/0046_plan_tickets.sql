ALTER TABLE "runs" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "tickets" jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "plans_one_proposed_per_request" ON "plans" USING btree ("request_id") WHERE "plans"."status" = 'proposed';--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project" CHECK ("runs"."purpose" = 'plan' OR "runs"."project_id" IS NOT NULL);