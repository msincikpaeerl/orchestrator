CREATE TABLE "setting_values" (
	"name" text NOT NULL,
	"project_id" uuid,
	"value" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setting_values_name_project" UNIQUE NULLS NOT DISTINCT("name","project_id")
);
--> statement-breakpoint
ALTER TABLE "setting_values" ADD CONSTRAINT "setting_values_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;