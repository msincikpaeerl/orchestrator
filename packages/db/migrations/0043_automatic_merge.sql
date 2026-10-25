ALTER TABLE "projects" ADD COLUMN "merges_automatic" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "automatic_merge" jsonb;