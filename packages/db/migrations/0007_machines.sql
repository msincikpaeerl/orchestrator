CREATE TABLE "claude_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"plan" text NOT NULL,
	"max_concurrent_runs" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'available' NOT NULL,
	"limited_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claude_accounts_plan" CHECK ("claude_accounts"."plan" IN ('pro', 'max_5x', 'max_20x')),
	CONSTRAINT "claude_accounts_max_concurrent_runs" CHECK ("claude_accounts"."max_concurrent_runs" BETWEEN 1 AND 10),
	CONSTRAINT "claude_accounts_state" CHECK ("claude_accounts"."state" IN ('available', 'paused_manual', 'limited'))
);
--> statement-breakpoint
CREATE TABLE "machines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"account_id" uuid NOT NULL,
	"status" text DEFAULT 'offline' NOT NULL,
	"os" text,
	"daemon_version" text,
	"protocol_version" integer,
	"claude_code_version" text,
	"doctor" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detected_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"added_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"removed_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"daemon_incompatible_since" timestamp with time zone,
	"claude_code_unsupported_since" timestamp with time zone,
	"doctor_error_since" timestamp with time zone,
	"enrolled_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"token_hash" text,
	"enrollment_code_hash" text,
	"enrollment_code_expires_at" timestamp with time zone,
	"enrollment_code_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machines_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "machines_enrollment_code_hash_unique" UNIQUE("enrollment_code_hash"),
	CONSTRAINT "machines_status" CHECK ("machines"."status" IN ('online', 'offline')),
	CONSTRAINT "machines_os" CHECK ("machines"."os" IN ('linux', 'wsl'))
);
--> statement-breakpoint
ALTER TABLE "github_connection" ADD COLUMN "account_id" bigint;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_account_id_claude_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."claude_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "claude_accounts_label" ON "claude_accounts" USING btree (lower("label"));--> statement-breakpoint
CREATE UNIQUE INDEX "machines_name" ON "machines" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "machines_account_id" ON "machines" USING btree ("account_id");