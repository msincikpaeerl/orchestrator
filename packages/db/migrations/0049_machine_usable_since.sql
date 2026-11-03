ALTER TABLE "machines" ADD COLUMN "usable_since" timestamp with time zone;--> statement-breakpoint
-- A machine that connected before 0.6.0 became usable at that connection (lot 5 step M2b).
UPDATE "machines" SET "usable_since" = "connected_at";
