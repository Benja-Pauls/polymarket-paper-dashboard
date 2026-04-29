CREATE TABLE "daily_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"strategy_id" text NOT NULL,
	"snapshot_date" date NOT NULL,
	"cash" double precision NOT NULL,
	"n_open_positions" integer NOT NULL,
	"total_open_stake" double precision NOT NULL,
	"cumulative_pnl" double precision NOT NULL,
	"n_bets_total" integer NOT NULL,
	"n_closed_total" integer DEFAULT 0 NOT NULL,
	"realized_pnl" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"condition_id" text PRIMARY KEY NOT NULL,
	"question_text" text,
	"category" text,
	"resolution_timestamp" bigint,
	"payouts_json" jsonb,
	"resolved" integer DEFAULT 0 NOT NULL,
	"winner_outcome_idx" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" serial PRIMARY KEY NOT NULL,
	"strategy_id" text NOT NULL,
	"signal_id" integer,
	"market_cid" text NOT NULL,
	"side" text,
	"entry_price" double precision NOT NULL,
	"bet_outcome" integer NOT NULL,
	"stake" double precision NOT NULL,
	"entry_ts" bigint NOT NULL,
	"planned_resolution_ts" bigint,
	"payout" double precision,
	"realized_return" double precision,
	"settled_ts" bigint,
	"won" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" serial PRIMARY KEY NOT NULL,
	"strategy_id" text NOT NULL,
	"market_cid" text NOT NULL,
	"raw_trade_id" text NOT NULL,
	"raw_wallet" text,
	"raw_ts" bigint NOT NULL,
	"raw_side" text,
	"raw_price" double precision,
	"raw_outcome_idx" integer,
	"decision" text NOT NULL,
	"reason" text,
	"entry_price" double precision,
	"bet_outcome" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategies" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"params_json" jsonb NOT NULL,
	"starting_bankroll" double precision NOT NULL,
	"current_cash" double precision NOT NULL,
	"stake" double precision NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"halt_reason" text,
	"last_poll_ts" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategies_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "daily_snapshots" ADD CONSTRAINT "daily_snapshots_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_snapshots_unique_idx" ON "daily_snapshots" USING btree ("strategy_id","snapshot_date");--> statement-breakpoint
CREATE INDEX "positions_strategy_open_idx" ON "positions" USING btree ("strategy_id","settled_ts");--> statement-breakpoint
CREATE INDEX "positions_strategy_market_idx" ON "positions" USING btree ("strategy_id","market_cid");--> statement-breakpoint
CREATE INDEX "positions_strategy_entry_ts_idx" ON "positions" USING btree ("strategy_id","entry_ts");--> statement-breakpoint
CREATE INDEX "signals_strategy_ts_idx" ON "signals" USING btree ("strategy_id","raw_ts");--> statement-breakpoint
CREATE INDEX "signals_strategy_market_idx" ON "signals" USING btree ("strategy_id","market_cid");--> statement-breakpoint
CREATE INDEX "signals_strategy_decision_idx" ON "signals" USING btree ("strategy_id","decision");--> statement-breakpoint
CREATE INDEX "signals_dedup_idx" ON "signals" USING btree ("strategy_id","raw_trade_id");