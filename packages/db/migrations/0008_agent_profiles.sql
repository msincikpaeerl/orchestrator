CREATE TABLE "agent_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"role" text NOT NULL,
	"instructions" text NOT NULL,
	"model" text NOT NULL,
	"allowed_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mcp_permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_default" boolean NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"shipped_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_profiles_key_unique" UNIQUE("key"),
	CONSTRAINT "agent_profiles_key_format" CHECK ("agent_profiles"."key" ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "agent_profiles_role" CHECK ("agent_profiles"."role" IN ('planner', 'builder', 'reviewer', 'writer')),
	CONSTRAINT "agent_profiles_version" CHECK ("agent_profiles"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "assignee_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_profile_id_agent_profiles_id_fk" FOREIGN KEY ("assignee_profile_id") REFERENCES "public"."agent_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tickets_assignee_profile_id" ON "tickets" USING btree ("assignee_profile_id");