// Server-side queries used by the dashboard pages. All read-only.
import "server-only";
import { and, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";

import { db } from "./db";
import {
  dailySnapshots,
  markets,
  positions as positionsTable,
  signals as signalsTable,
  strategies,
  strategyMethodology,
  type DailySnapshot,
  type Market,
  type Position,
  type Signal,
  type Strategy,
  type StrategyMethodology,
} from "./db/schema";
import { computeTripwireStatus, type TripwireStatus } from "./strategy";

export type StrategySummary = {
  strategy: Strategy;
  cashCurrent: number;
  /**
   * Realized + unrealized P&L. The unrealized portion comes from MTM-ing
   * each open position against the latest current_yes_price on its market
   * (refreshed every 5 min by the refresh-position-prices cron). This is
   * what the dashboard headlines — gives ongoing signal without waiting
   * 30+ days for resolution.
   */
  cumulativePnl: number;
  /** Settled positions only: payout - stake summed across all closed bets. */
  realizedPnl: number;
  /**
   * Open positions valued at current_yes_price (or 1 - yes_price for NO bets)
   * minus their stake. Positive = bets are winning so far at market;
   * negative = bets are losing at market. Positions on markets where we
   * don't have a price yet contribute 0 (treated as cost-basis), so this
   * is a lower bound on signal — when the next price-refresh cron fires,
   * the true number replaces it.
   */
  unrealizedPnl: number;
  /**
   * Open positions at cost-basis (sum of stakes). Old metric, kept because
   * the home-page card shows "$X locked in N open" — those numbers should
   * still be cost-basis to communicate "this is what we have at risk."
   */
  totalOpenStake: number;
  /** Open positions at MTM (current value, not cost basis). */
  totalOpenMtm: number;
  /** Number of open positions where we have a fresh price (not cost-basis). */
  nOpenWithPrice: number;
  nOpen: number;
  nClosed: number;
  nBetsTotal: number;
  hitRate: number | null; // wins / closed
  sparkline: { date: string; cumulativePnl: number }[]; // last 7
};

export async function listStrategies(): Promise<Strategy[]> {
  // Active first; within each status group, ordered by name for stability.
  return db
    .select()
    .from(strategies)
    .orderBy(
      sql`case ${strategies.status} when 'active' then 0 when 'halted' then 1 else 2 end`,
      strategies.name,
    );
}

export async function getStrategy(id: string): Promise<Strategy | null> {
  const r = await db.select().from(strategies).where(eq(strategies.id, id)).limit(1);
  return r[0] ?? null;
}

export async function getStrategySummary(s: Strategy): Promise<StrategySummary> {
  // Pull open positions JOINED to markets so we can MTM them against the
  // latest current_yes_price. Positions on markets we never priced will
  // have currentYesPrice=null and fall back to cost-basis.
  const openRows = await db
    .select({
      stake: positionsTable.stake,
      entryPrice: positionsTable.entryPrice,
      betOutcome: positionsTable.betOutcome,
      currentYesPrice: markets.currentYesPrice,
    })
    .from(positionsTable)
    .leftJoin(markets, eq(positionsTable.marketCid, markets.conditionId))
    .where(and(eq(positionsTable.strategyId, s.id), isNull(positionsTable.settledTs)));

  const closedRows = await db
    .select({
      payout: positionsTable.payout,
      stake: positionsTable.stake,
      won: positionsTable.won,
    })
    .from(positionsTable)
    .where(and(eq(positionsTable.strategyId, s.id), isNotNull(positionsTable.settledTs)));

  const nBetsResult = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(signalsTable)
    .where(and(eq(signalsTable.strategyId, s.id), eq(signalsTable.decision, "bet")));

  const nOpen = openRows.length;
  let totalOpenStake = 0;
  let totalOpenMtm = 0;
  let nOpenWithPrice = 0;
  let unrealizedPnl = 0;
  for (const r of openRows) {
    const stake = Number(r.stake);
    totalOpenStake += stake;
    const entryPrice = Number(r.entryPrice);
    const yesPrice = r.currentYesPrice;
    // Mark-to-market a binary bet: shares = stake / entry_price, then value
    // those shares at the current price of the side we bought.
    //   bet_outcome=0 (bought YES) -> current value = shares * yes_price
    //   bet_outcome=1 (bought NO)  -> current value = shares * (1 - yes_price)
    // If we don't have a fresh price for this market, treat at cost-basis
    // (no unrealized contribution) — better to under-report than show a
    // misleading positive based on stale data.
    if (yesPrice == null || !Number.isFinite(entryPrice) || entryPrice <= 0) {
      totalOpenMtm += stake;
      continue;
    }
    nOpenWithPrice += 1;
    const shares = stake / entryPrice;
    const sidePrice = r.betOutcome === 0 ? yesPrice : 1 - yesPrice;
    const mtmValue = shares * sidePrice;
    totalOpenMtm += mtmValue;
    unrealizedPnl += mtmValue - stake;
  }

  const nClosed = closedRows.length;
  const wins = closedRows.filter((r) => r.won === 1).length;
  const realizedPnl = closedRows.reduce(
    (acc, r) => acc + ((r.payout ?? 0) - Number(r.stake)),
    0,
  );
  // True P&L = realized (settled positions) + unrealized (MTM open positions).
  // Equivalent to: currentCash + totalOpenMtm - startingBankroll, since
  // currentCash already accounts for stakes that left the bankroll.
  const cumulativePnl =
    Number(s.currentCash) + totalOpenMtm - Number(s.startingBankroll);

  const snaps = await db
    .select()
    .from(dailySnapshots)
    .where(eq(dailySnapshots.strategyId, s.id))
    .orderBy(desc(dailySnapshots.snapshotDate))
    .limit(7);
  const sparkline = snaps
    .slice()
    .reverse()
    .map((sn) => ({
      date: sn.snapshotDate as unknown as string,
      cumulativePnl: Number(sn.cumulativePnl),
    }));

  return {
    strategy: s,
    cashCurrent: Number(s.currentCash),
    cumulativePnl,
    realizedPnl,
    unrealizedPnl,
    totalOpenStake,
    totalOpenMtm,
    nOpenWithPrice,
    nOpen,
    nClosed,
    nBetsTotal: nBetsResult[0]?.c ?? 0,
    hitRate: nClosed > 0 ? wins / nClosed : null,
    sparkline,
  };
}

export type WealthCurvePoint = {
  date: string;
  cumulativePnl: number;
  cash: number;
  realizedPnl: number;
  nClosed: number;
};

export async function getWealthCurve(strategyId: string): Promise<WealthCurvePoint[]> {
  const snaps = await db
    .select()
    .from(dailySnapshots)
    .where(eq(dailySnapshots.strategyId, strategyId))
    .orderBy(dailySnapshots.snapshotDate);
  return snaps.map((s) => ({
    date: s.snapshotDate as unknown as string,
    cumulativePnl: Number(s.cumulativePnl),
    cash: Number(s.cash),
    realizedPnl: Number(s.realizedPnl),
    nClosed: s.nClosedTotal,
  }));
}

// Base shape — Position + the joined market metadata. Both Open and Closed
// rows extend this; only Open carries MTM fields (closed positions resolve
// to a definite payout, so unrealized is moot).
type PositionWithMarket = Position & {
  question: string | null;
  category: string | null;
  resolutionTimestamp: number | null;
};

export type OpenPositionRow = PositionWithMarket & {
  /** Latest YES price from Gamma. NO-side price = 1 - this. Null if never priced. */
  currentYesPrice: number | null;
  priceUpdatedAt: Date | null;
  /** MTM value (current market value of the position in USDC). */
  mtmValue: number | null;
  /** mtmValue - stake; positive = winning at market, negative = losing. */
  unrealizedPnl: number | null;
  /** unrealizedPnl / stake; null when no price yet. */
  unrealizedReturnPct: number | null;
};

export async function getOpenPositions(strategyId: string, limit = 200): Promise<OpenPositionRow[]> {
  const rows = await db
    .select({
      position: positionsTable,
      market: markets,
    })
    .from(positionsTable)
    .leftJoin(markets, eq(positionsTable.marketCid, markets.conditionId))
    .where(and(eq(positionsTable.strategyId, strategyId), isNull(positionsTable.settledTs)))
    .orderBy(desc(positionsTable.entryTs))
    .limit(limit);
  return rows.map(({ position, market }) => mapOpenPositionRow(position, market));
}

/**
 * Mark-to-market a position against its market's latest YES price.
 * Used by both getOpenPositions and getMarketDetail; centralized here so
 * the MTM math is defined once.
 */
function mapOpenPositionRow(
  position: Position,
  market: Market | null,
): OpenPositionRow {
  const stake = Number(position.stake);
  const entryPrice = Number(position.entryPrice);
  const yesPrice = market?.currentYesPrice ?? null;
  let mtmValue: number | null = null;
  let unrealizedPnl: number | null = null;
  let unrealizedReturnPct: number | null = null;
  if (yesPrice != null && Number.isFinite(entryPrice) && entryPrice > 0) {
    const shares = stake / entryPrice;
    // shares × current_price_of_the_side_we_bought
    const sidePrice = position.betOutcome === 0 ? yesPrice : 1 - yesPrice;
    mtmValue = shares * sidePrice;
    unrealizedPnl = mtmValue - stake;
    unrealizedReturnPct = unrealizedPnl / stake;
  }
  return {
    ...position,
    question: market?.questionText ?? null,
    category: market?.category ?? null,
    resolutionTimestamp: market?.resolutionTimestamp ?? null,
    currentYesPrice: yesPrice,
    priceUpdatedAt: market?.priceUpdatedAt ?? null,
    mtmValue,
    unrealizedPnl,
    unrealizedReturnPct,
  };
}

export type ClosedPositionRow = PositionWithMarket & { realizedReturnPct: number | null };

export async function getClosedPositions(
  strategyId: string,
  limit = 200,
): Promise<ClosedPositionRow[]> {
  const rows = await db
    .select({ position: positionsTable, market: markets })
    .from(positionsTable)
    .leftJoin(markets, eq(positionsTable.marketCid, markets.conditionId))
    .where(and(eq(positionsTable.strategyId, strategyId), isNotNull(positionsTable.settledTs)))
    .orderBy(desc(positionsTable.settledTs))
    .limit(limit);
  return rows.map(({ position, market }) => ({
    ...position,
    question: market?.questionText ?? null,
    category: market?.category ?? null,
    resolutionTimestamp: market?.resolutionTimestamp ?? null,
    realizedReturnPct:
      position.realizedReturn != null ? Number(position.realizedReturn) * 100 : null,
  }));
}

export type SignalRow = Signal & { question: string | null; category: string | null };

export async function getRecentSignals(
  strategyId: string,
  limit = 50,
  decision?: "bet" | "skip",
): Promise<SignalRow[]> {
  const conds = [eq(signalsTable.strategyId, strategyId)];
  if (decision) conds.push(eq(signalsTable.decision, decision));
  const rows = await db
    .select({ signal: signalsTable, market: markets })
    .from(signalsTable)
    .leftJoin(markets, eq(signalsTable.marketCid, markets.conditionId))
    .where(and(...conds))
    .orderBy(desc(signalsTable.rawTs))
    .limit(limit);
  return rows.map(({ signal, market }) => ({
    ...signal,
    question: market?.questionText ?? null,
    category: market?.category ?? null,
  }));
}

export async function getStrategyTripwires(strategy: Strategy): Promise<TripwireStatus> {
  const closedRows = await db
    .select({
      payout: positionsTable.payout,
      stake: positionsTable.stake,
      marketCid: positionsTable.marketCid,
      settledTs: positionsTable.settledTs,
    })
    .from(positionsTable)
    .where(
      and(eq(positionsTable.strategyId, strategy.id), isNotNull(positionsTable.settledTs)),
    );

  const cumulativePnl = closedRows.reduce(
    (s, r) => s + ((r.payout ?? 0) - Number(r.stake)),
    0,
  );

  // Weekly P&L: closed in last 7 days
  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
  const weeklyPnl = closedRows
    .filter((r) => (r.settledTs ?? 0) >= sevenDaysAgo)
    .reduce((s, r) => s + ((r.payout ?? 0) - Number(r.stake)), 0);

  // Top-1 market concentration (% of |total P&L|)
  const perMarket = new Map<string, number>();
  for (const r of closedRows) {
    perMarket.set(
      r.marketCid,
      (perMarket.get(r.marketCid) ?? 0) + ((r.payout ?? 0) - Number(r.stake)),
    );
  }
  const absTotal = [...perMarket.values()].reduce((s, v) => s + Math.abs(v), 0);
  const top1 = [...perMarket.values()].reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const top1ConcentrationPct = absTotal > 0 ? (top1 / absTotal) * 100 : 0;

  return computeTripwireStatus({
    startingBankroll: Number(strategy.startingBankroll),
    cumulativePnl,
    weeklyPnl,
    top1ConcentrationPct,
  });
}

export type MarketDetail = {
  market: Market;
  positions: OpenPositionRow[];
  signals: SignalRow[];
};

export async function getMarketDetail(
  strategyId: string,
  conditionId: string,
): Promise<MarketDetail | null> {
  const m = await db
    .select()
    .from(markets)
    .where(eq(markets.conditionId, conditionId))
    .limit(1);
  if (m.length === 0) return null;

  const posRows = await db
    .select({ position: positionsTable, market: markets })
    .from(positionsTable)
    .leftJoin(markets, eq(positionsTable.marketCid, markets.conditionId))
    .where(
      and(
        eq(positionsTable.strategyId, strategyId),
        eq(positionsTable.marketCid, conditionId),
      ),
    )
    .orderBy(desc(positionsTable.entryTs));

  const sigRows = await db
    .select({ signal: signalsTable, market: markets })
    .from(signalsTable)
    .leftJoin(markets, eq(signalsTable.marketCid, markets.conditionId))
    .where(
      and(
        eq(signalsTable.strategyId, strategyId),
        eq(signalsTable.marketCid, conditionId),
      ),
    )
    .orderBy(desc(signalsTable.rawTs))
    .limit(50);

  return {
    market: m[0],
    positions: posRows.map(({ position, market }) => mapOpenPositionRow(position, market)),
    signals: sigRows.map(({ signal, market }) => ({
      ...signal,
      question: market?.questionText ?? null,
      category: market?.category ?? null,
    })),
  };
}

/** Returns the methodology row for a strategy (or null if none seeded). */
export async function getStrategyMethodology(
  strategyId: string,
): Promise<StrategyMethodology | null> {
  const r = await db
    .select()
    .from(strategyMethodology)
    .where(eq(strategyMethodology.strategyId, strategyId))
    .limit(1);
  return r[0] ?? null;
}

/**
 * Returns a map { strategyId -> barStatus } so the leaderboard can render a
 * Bar-status badge on each card without hitting the DB once per strategy.
 */
export async function listStrategyBarStatuses(): Promise<Record<string, string>> {
  const rows = await db
    .select({
      strategyId: strategyMethodology.strategyId,
      barStatus: strategyMethodology.barStatus,
    })
    .from(strategyMethodology);
  const out: Record<string, string> = {};
  for (const r of rows) out[r.strategyId] = r.barStatus;
  return out;
}
