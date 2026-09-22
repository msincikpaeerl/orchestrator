CREATE TABLE "events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_connection" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"account" text NOT NULL,
	"expires_on" date,
	"saved_at" timestamp with time zone NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"permissions" jsonb NOT NULL,
	"invalid_since" timestamp with time zone,
	"refusals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "github_connection_single_row" CHECK ("github_connection"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "owner" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_single_row" CHECK ("owner"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"name" text PRIMARY KEY NOT NULL,
	"scheme" smallint NOT NULL,
	"nonce" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
