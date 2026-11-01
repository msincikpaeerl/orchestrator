ALTER TABLE "owner" ADD COLUMN "setup_finished_at" timestamp with time zone;--> statement-breakpoint
-- An owner created before 0.6.0 went through the wizard of that version: never sent through steps 3 and 4 (lot 5 step J).
UPDATE "owner" SET "setup_finished_at" = now();
