CREATE TABLE "cron_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"cron_name" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"status" text NOT NULL,
	"result_json" jsonb,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "cron_runs_name_started_idx" ON "cron_runs" USING btree ("cron_name","started_at");