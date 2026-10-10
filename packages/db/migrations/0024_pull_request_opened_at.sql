-- Lot 3 step G2c (the owner's fix): when the server last opened or reopened the ticket's pull
-- request, or first found it open; Check CI again accepts "No CI found" only after Wait for CI to
-- start from then.
ALTER TABLE "tickets" ADD COLUMN "pull_request_opened_at" timestamp with time zone;
