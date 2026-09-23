CREATE TABLE "login_failures" (
	"key" text PRIMARY KEY NOT NULL,
	"failures" integer NOT NULL,
	"last_failure_at" timestamp with time zone NOT NULL,
	"blocked_until" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "github_connection" ADD COLUMN "unreadable_since" timestamp with time zone;