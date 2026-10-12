ALTER TABLE "branch_clean_ups" ADD COLUMN "message_id" uuid;--> statement-breakpoint
ALTER TABLE "branch_clean_ups" ADD COLUMN "sent_at" timestamp with time zone;