ALTER TABLE "events" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Events written before this migration (lots 0 and 1) get the project they concern: a project's
-- own events, its tickets' events and its setting overrides. The others concern no project.
-- Ids are compared as text, so an unexpected entity id is left without a project, never an error.
UPDATE "events" AS e SET "project_id" = p."id" FROM "projects" AS p
WHERE e."entity_type" = 'project' AND e."entity_id" = p."id"::text;--> statement-breakpoint
UPDATE "events" AS e SET "project_id" = t."project_id" FROM "tickets" AS t
WHERE e."entity_type" = 'ticket' AND e."entity_id" = t."id"::text;--> statement-breakpoint
UPDATE "events" AS e SET "project_id" = p."id" FROM "projects" AS p
WHERE e."entity_type" = 'setting' AND e."payload"->>'scope' = 'project'
  AND e."payload"->>'projectId' = p."id"::text;--> statement-breakpoint
CREATE INDEX "events_time" ON "events" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "events_project_time" ON "events" USING btree ("project_id","created_at","id");--> statement-breakpoint
CREATE INDEX "events_entity_time" ON "events" USING btree ("entity_type","entity_id","created_at","id");
