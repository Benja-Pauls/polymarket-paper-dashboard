CREATE TABLE "backtest_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_label" text NOT NULL,
	"run_description" text,
	"strategy_id" text NOT NULL,
	"data_span_start" text,
	"data_span_end" text,
	"n_bets" integer,
	"n_markets" integer,
	"bankroll" double precision,
	"stake" double precision,
	"mean_ret_per_dollar" double precision,
	"total_pnl" double precision,
	"p5" double precision,
	"p50" double precision,
	"p95" double precision,
	"p_pos" double precision,
	"top1_conc" double precision,
	"bets_per_month" double precision,
	"result_json" jsonb,
	"run_started_at" timestamp with time zone,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "backtest_runs_strategy_idx" ON "backtest_runs" USING btree ("strategy_id","run_started_at");--> statement-breakpoint
CREATE INDEX "backtest_runs_label_idx" ON "backtest_runs" USING btree ("run_label");