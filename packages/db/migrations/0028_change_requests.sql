ALTER TABLE "tickets" ADD COLUMN "review_rounds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "stopped" jsonb;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "change_request" jsonb;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "change_request_answered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_review_rounds" CHECK ("tickets"."review_rounds" >= 0);