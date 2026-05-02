CREATE TABLE "forward_oos_validations" (
	"id" serial PRIMARY KEY NOT NULL,
	"strategy_id" text NOT NULL,
	"run_label" text NOT NULL,
	"validated_at" timestamp with time zone NOT NULL,
	"gates_passed" jsonb,
	"overall_verdict" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "forward_oos_validations" ADD CONSTRAINT "forward_oos_validations_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "forward_oos_strategy_idx" ON "forward_oos_validations" USING btree ("strategy_id","validated_at");