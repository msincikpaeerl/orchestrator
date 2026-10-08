-- Lot 3 step F4: why the workflow flag is raised, `changed` (a file under .github/workflows/)
-- or `not_listed` (the machine's list of changed files cut or not sent). Rows flagged before keep
-- null: the reason was not kept, and the changed files never are, so it cannot be found again;
-- the ticket page shows them a sentence covering both reasons. No release has such rows (0.4.0).
ALTER TABLE "tickets" ADD COLUMN "workflow_reason" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_workflow_reason" CHECK ("tickets"."workflow_reason" IN ('changed', 'not_listed'));
