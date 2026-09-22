CREATE TABLE "schema_info" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schema_info_single_row" CHECK ("schema_info"."id" = 1)
);
--> statement-breakpoint
-- Added by hand: the single row recording when the database was initialised.
INSERT INTO "schema_info" DEFAULT VALUES;
