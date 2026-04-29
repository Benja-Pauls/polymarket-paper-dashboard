CREATE TABLE "strategy_methodology" (
	"strategy_id" text PRIMARY KEY NOT NULL,
	"hypothesis" text NOT NULL,
	"in_sample_metrics" jsonb,
	"forward_metrics" jsonb,
	"per_year_metrics" jsonb,
	"filter_descriptions" jsonb,
	"known_issues" text,
	"bar_status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "strategy_methodology" ADD CONSTRAINT "strategy_methodology_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE cascade ON UPDATE no action;