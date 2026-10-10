ALTER TABLE "runs" ADD COLUMN "review_moved" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "review_moved_head" text;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_review_moved" CHECK ("runs"."review_moved" IN ('before_start', 'machine', 'github'));