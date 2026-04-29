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
  type DailySnapshot,
  type Market,
  type Position,
  type Signal,
  type Strategy,
} from "./db/schema";
import { computeTripwireStatus, type TripwireStatus } from "./strategy";

export type StrategySummary = {
  strategy: Strategy;
  cashCurrent: number;
  cumulativePnl: number;
  realizedPnl: number;
  nOpen: number;
  nClosed: number;
  nBetsTotal: number;
  hitRate: number | null; // wins / closed
  totalOpenStake: number;
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
  const openRows = await db
    .select({ stake: positionsTable.stake })
    .from(positionsTable)
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
  const totalOpenStake = openRows.reduce((acc, r) => acc + Number(r.stake), 0);
  const nClosed = closedRows.length;
  const wins = closedRows.filter((r) => r.won === 1).length;
  const realizedPnl = closedRows.reduce(
    (acc, r) => acc + ((r.payout ?? 0) - Number(r.stake)),
    0,
  );
  const cumulativePnl = Number(s.currentCash) + totalOpenStake - Number(s.startingBankroll);

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
    nOpen,
    nClosed,
    nBetsTotal: nBetsResult[0]?.c ?? 0,
    hitRate: nClosed > 0 ? wins / nClosed : null,
    totalOpenStake,
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

export type OpenPositionRow = Position & {
  question: string | null;
  category: string | null;
  resolutionTimestamp: number | null;
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
  return rows.map(({ position, market }) => ({
    ...position,
    question: market?.questionText ?? null,
    category: market?.category ?? null,
    resolutionTimestamp: market?.resolutionTimestamp ?? null,
  }));
}

export type ClosedPositionRow = OpenPositionRow & { realizedReturnPct: number | null };

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
    positions: posRows.map(({ position, market }) => ({
      ...position,
      question: market?.questionText ?? null,
      category: market?.category ?? null,
      resolutionTimestamp: market?.resolutionTimestamp ?? null,
    })),
    signals: sigRows.map(({ signal, market }) => ({
      ...signal,
      question: market?.questionText ?? null,
      category: market?.category ?? null,
    })),
  };
}
