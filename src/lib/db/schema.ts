import {
  pgTable,
  text,
  integer,
  bigint,
  doublePrecision,
  timestamp,
  jsonb,
  serial,
  date,
  index,
} from "drizzle-orm/pg-core";

// ─────────────────────────────────────────────────────────────────────────────
// Strategy: a paper-money trading strategy
// ─────────────────────────────────────────────────────────────────────────────
export const strategies = pgTable("strategies", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  paramsJson: jsonb("params_json").notNull().$type<Record<string, unknown>>(),
  startingBankroll: doublePrecision("starting_bankroll").notNull(),
  currentCash: doublePrecision("current_cash").notNull(),
  stake: doublePrecision("stake").notNull(),
  status: text("status").notNull().default("active"), // active | halted | retired
  haltReason: text("halt_reason"),
  lastPollTs: bigint("last_poll_ts", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Market: a Polymarket market we're watching
// ─────────────────────────────────────────────────────────────────────────────
export const markets = pgTable("markets", {
  conditionId: text("condition_id").primaryKey(),
  questionText: text("question_text"),
  category: text("category"),
  resolutionTimestamp: bigint("resolution_timestamp", { mode: "number" }),
  payoutsJson: jsonb("payouts_json").$type<string[] | null>(),
  resolved: integer("resolved").notNull().default(0), // 0/1
  winnerOutcomeIdx: integer("winner_outcome_idx"),
  /**
   * Running cumulative on-chain USDC notional we've SEEN on this market across
   * all polled trades, regardless of strategy. Used by the `max_market_volume`
   * filter (we evaluate trades chronologically and bump this AFTER eval).
   * Strategy-agnostic — shared across every strategy. Approximate; only
   * counts trades since the cron started polling.
   */
  runningVolumeUsdc: doublePrecision("running_volume_usdc").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Signal: a candidate trade evaluated by a strategy (decided bet/skip)
// ─────────────────────────────────────────────────────────────────────────────
export const signals = pgTable(
  "signals",
  {
    id: serial("id").primaryKey(),
    strategyId: text("strategy_id")
      .notNull()
      .references(() => strategies.id, { onDelete: "cascade" }),
    marketCid: text("market_cid").notNull(),
    rawTradeId: text("raw_trade_id").notNull(),
    rawWallet: text("raw_wallet"),
    rawTs: bigint("raw_ts", { mode: "number" }).notNull(),
    rawSide: text("raw_side"),
    rawPrice: doublePrecision("raw_price"),
    rawOutcomeIdx: integer("raw_outcome_idx"),
    decision: text("decision").notNull(), // 'bet' | 'skip'
    reason: text("reason"),
    entryPrice: doublePrecision("entry_price"),
    betOutcome: integer("bet_outcome"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("signals_strategy_ts_idx").on(t.strategyId, t.rawTs),
    index("signals_strategy_market_idx").on(t.strategyId, t.marketCid),
    index("signals_strategy_decision_idx").on(t.strategyId, t.decision),
    index("signals_dedup_idx").on(t.strategyId, t.rawTradeId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Position: an open or closed paper-money position
// ─────────────────────────────────────────────────────────────────────────────
export const positions = pgTable(
  "positions",
  {
    id: serial("id").primaryKey(),
    strategyId: text("strategy_id")
      .notNull()
      .references(() => strategies.id, { onDelete: "cascade" }),
    signalId: integer("signal_id").references(() => signals.id, {
      onDelete: "set null",
    }),
    marketCid: text("market_cid").notNull(),
    side: text("side"),
    entryPrice: doublePrecision("entry_price").notNull(),
    betOutcome: integer("bet_outcome").notNull(),
    stake: doublePrecision("stake").notNull(),
    entryTs: bigint("entry_ts", { mode: "number" }).notNull(),
    plannedResolutionTs: bigint("planned_resolution_ts", { mode: "number" }),
    payout: doublePrecision("payout"),
    realizedReturn: doublePrecision("realized_return"),
    settledTs: bigint("settled_ts", { mode: "number" }),
    won: integer("won"), // null while open, 0/1 once settled
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("positions_strategy_open_idx").on(t.strategyId, t.settledTs),
    index("positions_strategy_market_idx").on(t.strategyId, t.marketCid),
    index("positions_strategy_entry_ts_idx").on(t.strategyId, t.entryTs),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Market catalyst: an upcoming/known public event tied to a market's outcome.
// Used by strategies that filter on `require_future_catalyst` — only bet when a
// catalyst is in the future at trade time.
// Source: research repo `data/features/market_catalysts_v2.parquet`.
// ─────────────────────────────────────────────────────────────────────────────
export const marketCatalysts = pgTable(
  "market_catalysts",
  {
    conditionId: text("condition_id").primaryKey(),
    catalystTs: bigint("catalyst_ts", { mode: "number" }).notNull(),
    catalystSource: text("catalyst_source"),
    catalystConfidence: text("catalyst_confidence"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("market_catalysts_cid_idx").on(t.conditionId)],
);

// ─────────────────────────────────────────────────────────────────────────────
// Daily snapshot: per-strategy P&L for charting
// ─────────────────────────────────────────────────────────────────────────────
export const dailySnapshots = pgTable(
  "daily_snapshots",
  {
    id: serial("id").primaryKey(),
    strategyId: text("strategy_id")
      .notNull()
      .references(() => strategies.id, { onDelete: "cascade" }),
    snapshotDate: date("snapshot_date").notNull(),
    cash: doublePrecision("cash").notNull(),
    nOpenPositions: integer("n_open_positions").notNull(),
    totalOpenStake: doublePrecision("total_open_stake").notNull(),
    cumulativePnl: doublePrecision("cumulative_pnl").notNull(),
    nBetsTotal: integer("n_bets_total").notNull(),
    nClosedTotal: integer("n_closed_total").notNull().default(0),
    realizedPnl: doublePrecision("realized_pnl").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("daily_snapshots_unique_idx").on(t.strategyId, t.snapshotDate)],
);

// ─────────────────────────────────────────────────────────────────────────────
// Strategy methodology: the "why" behind each strategy. One row per strategy.
// Read-only documentation surface, populated by `scripts/seed_methodology.ts`.
// Renders on the strategy detail page under the Methodology tab so the
// dashboard doubles as a reference doc that's queryable separately from
// chat conversations.
// ─────────────────────────────────────────────────────────────────────────────
export type FilterDescription = {
  name: string;
  description: string;
  validation: string;
};

export type MethodologyMetrics = {
  mean_ret_per_dollar?: number;
  total_pnl?: number;
  p5?: number;
  p_pos?: number;
  top1_pct?: number;
  n_bets?: number;
  n_markets?: number;
  // Free-form annotation, e.g. "21mo (Aug 2024 – Apr 2026)".
  span_label?: string;
};

export const strategyMethodology = pgTable("strategy_methodology", {
  strategyId: text("strategy_id")
    .primaryKey()
    .references(() => strategies.id, { onDelete: "cascade" }),
  hypothesis: text("hypothesis").notNull(),
  inSampleMetrics: jsonb("in_sample_metrics").$type<MethodologyMetrics>(),
  forwardMetrics: jsonb("forward_metrics").$type<MethodologyMetrics>(),
  perYearMetrics: jsonb("per_year_metrics").$type<Record<string, MethodologyMetrics>>(),
  filterDescriptions: jsonb("filter_descriptions").$type<FilterDescription[]>(),
  knownIssues: text("known_issues"),
  // 'Bar 2 alpha' | 'Bar 1 floor' | 'borderline' | 'comparison'
  barStatus: text("bar_status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Backtest run: a single historical-backtest result for one strategy on a
// specific data window. Powers the /historical tab — operators see how each
// surviving strategy held up across expanding historical windows as the R&D
// team backfills more data.
//
// Workflow:
//   1. R&D agent runs `scripts/<some_backtest>.py` in the research repo,
//      producing a JSON file under `results/`.
//   2. Operator hits POST /api/admin/ingest-backtest with the path to the
//      JSON (or curls a paste). The endpoint normalises the JSON into one
//      row per (strategy, run) and writes here.
//   3. /historical page reads + groups by strategy_id, shows trends over
//      time (mean ret/$, P5, worst-month) as new rows accumulate.
//
// We don't try to enforce a strict numeric schema on the JSON because R&D
// formats evolve. Instead we hoist the headline metrics into typed columns
// and stash the full result in result_json for later querying.
// ─────────────────────────────────────────────────────────────────────────────
export const backtestRuns = pgTable(
  "backtest_runs",
  {
    id: serial("id").primaryKey(),
    // Logical run identifier — typically the filename of the JSON the
    // result came from (e.g. 'backtest_all_deployed.json'). Two different
    // strategies from the same JSON share the same run_label so they can
    // be displayed together.
    runLabel: text("run_label").notNull(),
    runDescription: text("run_description"),
    strategyId: text("strategy_id").notNull(),
    // ISO date strings — keep them as text so we can store exotic spans
    // ("Jan-Apr 2026 stratified") without forcing a date-typed window.
    dataSpanStart: text("data_span_start"),
    dataSpanEnd: text("data_span_end"),
    // Headline metrics — null when not reported (e.g. pre-bootstrap runs).
    nBets: integer("n_bets"),
    nMarkets: integer("n_markets"),
    bankroll: doublePrecision("bankroll"), // $5,000 default
    stake: doublePrecision("stake"), // $50 default
    meanRetPerDollar: doublePrecision("mean_ret_per_dollar"),
    totalPnl: doublePrecision("total_pnl"),
    p5: doublePrecision("p5"),
    p50: doublePrecision("p50"),
    p95: doublePrecision("p95"),
    pPos: doublePrecision("p_pos"),
    top1Conc: doublePrecision("top1_conc"),
    betsPerMonth: doublePrecision("bets_per_month"),
    // The full original JSON for this strategy's slice of the run, so we
    // never lose context.
    resultJson: jsonb("result_json").$type<Record<string, unknown> | null>(),
    runStartedAt: timestamp("run_started_at", { withTimezone: true }),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("backtest_runs_strategy_idx").on(t.strategyId, t.runStartedAt),
    index("backtest_runs_label_idx").on(t.runLabel),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Cron run: one row per cron-job invocation, written by the handler at the
// end of each run. Drives the /admin/crons observability page so we can see
// when each cron last fired, how long it took, and what it returned —
// without having to wade through Vercel logs.
// ─────────────────────────────────────────────────────────────────────────────
export const cronRuns = pgTable(
  "cron_runs",
  {
    id: serial("id").primaryKey(),
    // Logical name of the cron, e.g. 'poll' or 'sync-open-markets'. Matches
    // the URL path segment under /api/cron/<name>.
    cronName: text("cron_name").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    durationMs: integer("duration_ms").notNull(),
    // 'ok' | 'error' — split out so the dashboard can colour-code at a glance.
    status: text("status").notNull(),
    // Free-form structured result (e.g. trades_fetched, bets_placed). Keep
    // it small — the cron handlers only return summary counters anyway.
    resultJson: jsonb("result_json").$type<Record<string, unknown> | null>(),
    // Truncated error message when status='error'. Full stack stays in logs.
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("cron_runs_name_started_idx").on(t.cronName, t.startedAt),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Type exports
// ─────────────────────────────────────────────────────────────────────────────
export type Strategy = typeof strategies.$inferSelect;
export type NewStrategy = typeof strategies.$inferInsert;
export type Market = typeof markets.$inferSelect;
export type NewMarket = typeof markets.$inferInsert;
export type Signal = typeof signals.$inferSelect;
export type NewSignal = typeof signals.$inferInsert;
export type Position = typeof positions.$inferSelect;
export type NewPosition = typeof positions.$inferInsert;
export type DailySnapshot = typeof dailySnapshots.$inferSelect;
export type NewDailySnapshot = typeof dailySnapshots.$inferInsert;
export type MarketCatalyst = typeof marketCatalysts.$inferSelect;
export type NewMarketCatalyst = typeof marketCatalysts.$inferInsert;
export type StrategyMethodology = typeof strategyMethodology.$inferSelect;
export type NewStrategyMethodology = typeof strategyMethodology.$inferInsert;
export type CronRun = typeof cronRuns.$inferSelect;
export type NewCronRun = typeof cronRuns.$inferInsert;
export type BacktestRun = typeof backtestRuns.$inferSelect;
export type NewBacktestRun = typeof backtestRuns.$inferInsert;
