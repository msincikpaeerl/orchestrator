ALTER TABLE "runs" ALTER COLUMN "branch_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "request_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_active_per_request" ON "runs" USING btree ("request_id") WHERE "runs"."status" IN ('queued', 'dispatched', 'starting', 'running', 'waiting_human', 'paused_quota');--> statement-breakpoint
CREATE INDEX "runs_request_id" ON "runs" USING btree ("request_id","created_at");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_subject" CHECK (("runs"."purpose" = 'plan') = ("runs"."request_id" IS NOT NULL) AND ("runs"."purpose" = 'plan') = ("runs"."ticket_id" IS NULL) AND ("runs"."purpose" = 'plan') = ("runs"."branch_name" IS NULL));