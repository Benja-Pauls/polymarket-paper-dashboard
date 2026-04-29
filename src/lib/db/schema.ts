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
