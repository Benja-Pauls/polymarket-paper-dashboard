// Vercel Cron handler — polls Goldsky for new trades and applies the
// strategy filter. Runs every 5 minutes per `vercel.ts`.
//
// Logic:
//   1. Load active strategies and their last_poll_ts cursors.
//   2. Fetch new orderFilledEvents since cursor from the orderbook subgraph.
//   3. For each trade, decode token_id -> conditionId via either:
//        a. The DB markets table (if the cron has populated it for this market)
//        b. The activity-subgraph reverse lookup (if we haven't seen it before)
//   4. Apply strategy filter; insert Signal rows; for `bet` decisions insert
//      Position rows and decrement strategy.current_cash.
//   5. Settle any open positions whose markets resolved.
//   6. Take a daily snapshot per strategy.
//
// NO real-money execution. Paper-money only.

import { NextResponse } from "next/server";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  dailySnapshots,
  markets,
  positions as positionsTable,
  signals as signalsTable,
  strategies,
  type Strategy,
} from "@/lib/db/schema";
import {
  decodeTrade,
  fetchMarketMetadata,
  fetchMarketMetadataBatch,
  fetchMarketsForTokens,
  fetchTradesSince,
  type DecodedTrade,
} from "@/lib/goldsky";
import { STRATEGY, evaluateTrade, settlePosition, TRADEABLE_CATEGORIES } from "@/lib/strategy";

export const runtime = "nodejs";
export const maxDuration = 300; // 5 minutes
export const dynamic = "force-dynamic";

const NOW_S = () => Math.floor(Date.now() / 1000);

type MarketCacheEntry = {
  conditionId: string;
  category: string | null;
  resolutionTimestamp: number | null;
  resolved: 0 | 1;
  winnerOutcomeIdx: number | null;
  outcomeIdx: number; // for THIS token
};

// In-process token -> market cache. Survives within one cron invocation.
const tokenCache = new Map<string, MarketCacheEntry | null>();

function isAuthorized(req: Request): boolean {
  // Vercel sets `x-vercel-cron-signature` on cron-triggered requests.
  // For local manual triggers, allow if CRON_SECRET matches a header or
  // if VERCEL_ENV is unset (= local dev).
  if (req.headers.get("x-vercel-cron-signature")) return true;
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") || "";
    if (auth === `Bearer ${secret}`) return true;
    return false;
  }
  // No secret configured + no cron signature: allow only outside production.
  return process.env.VERCEL_ENV !== "production";
}

async function loadActiveStrategies(): Promise<Strategy[]> {
  return db.select().from(strategies).where(eq(strategies.status, "active"));
}

async function settleResolvedOpenPositions(args: {
  strategyId: string;
  slippage: number;
}): Promise<{ settled: number; cashDelta: number }> {
  const open = await db
    .select({
      pos: positionsTable,
      mkt: markets,
    })
    .from(positionsTable)
    .leftJoin(markets, eq(positionsTable.marketCid, markets.conditionId))
    .where(
      and(eq(positionsTable.strategyId, args.strategyId), isNull(positionsTable.settledTs)),
    );

  let settled = 0;
  let cashDelta = 0;
  for (const { pos, mkt } of open) {
    if (!mkt) continue;
    if (!mkt.resolved || mkt.winnerOutcomeIdx == null) {
      // Force a re-fetch of the market metadata in case it resolved since we
      // last looked. Use the conditionId.
      try {
        const live = await fetchMarketMetadata({ conditionId: mkt.conditionId });
        if (live && live.winnerOutcomeIdx != null) {
          await db
            .update(markets)
            .set({
              resolutionTimestamp: live.resolutionTimestamp,
              payoutsJson: live.payouts,
              resolved: 1,
              winnerOutcomeIdx: live.winnerOutcomeIdx,
              updatedAt: new Date(),
            })
            .where(eq(markets.conditionId, mkt.conditionId));
          mkt.winnerOutcomeIdx = live.winnerOutcomeIdx;
          mkt.resolved = 1;
        } else {
          continue;
        }
      } catch {
        continue;
      }
    }
    const outcome = mkt.winnerOutcomeIdx!;
    const settle = settlePosition({
      stake: pos.stake,
      entryPrice: pos.entryPrice,
      betOutcome: pos.betOutcome,
      winner: outcome,
      slippage: args.slippage,
    });
    await db
      .update(positionsTable)
      .set({
        won: settle.won,
        payout: settle.payout,
        realizedReturn: settle.realizedReturn,
        settledTs: NOW_S(),
      })
      .where(eq(positionsTable.id, pos.id));
    cashDelta += settle.payout;
    settled += 1;
  }
  if (cashDelta !== 0) {
    await db
      .update(strategies)
      .set({
        currentCash: sql`${strategies.currentCash} + ${cashDelta}`,
        updatedAt: new Date(),
      })
      .where(eq(strategies.id, args.strategyId));
  }
  return { settled, cashDelta };
}

async function takeDailySnapshot(strategyId: string) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC

  // Aggregate current state
  const [strat] = await db.select().from(strategies).where(eq(strategies.id, strategyId));
  if (!strat) return;
  const openRows = await db
    .select({ stake: positionsTable.stake })
    .from(positionsTable)
    .where(and(eq(positionsTable.strategyId, strategyId), isNull(positionsTable.settledTs)));
  const closedRows = await db
    .select({ payout: positionsTable.payout, stake: positionsTable.stake })
    .from(positionsTable)
    .where(and(eq(positionsTable.strategyId, strategyId), sql`${positionsTable.settledTs} is not null`));
  const nBetsTotal = (
    await db
      .select({ c: sql<number>`count(*)::int` })
      .from(signalsTable)
      .where(and(eq(signalsTable.strategyId, strategyId), eq(signalsTable.decision, "bet")))
  )[0]?.c ?? 0;

  const nOpen = openRows.length;
  const totalOpenStake = openRows.reduce((s, r) => s + Number(r.stake), 0);
  const realizedPnl = closedRows.reduce(
    (s, r) => s + ((r.payout ?? 0) - Number(r.stake)),
    0,
  );
  const cumPnl = strat.currentCash + totalOpenStake - strat.startingBankroll;
  const nClosed = closedRows.length;

  await db
    .insert(dailySnapshots)
    .values({
      strategyId,
      snapshotDate: today,
      cash: strat.currentCash,
      nOpenPositions: nOpen,
      totalOpenStake,
      cumulativePnl: cumPnl,
      nBetsTotal,
      nClosedTotal: nClosed,
      realizedPnl,
    })
    .onConflictDoNothing();
}

async function processStrategyForTrades(args: {
  strategy: Strategy;
  decoded: DecodedTrade[];
}) {
  const { strategy, decoded } = args;
  let nBetsAdded = 0;
  let nSkipped = 0;
  let nDuplicates = 0;
  let cashSpent = 0;

  // Refresh strategy in-process (we mutate locally) so we respect cap reads.
  let cash = strategy.currentCash;

  // Cache of marketCid -> count of existing bet signals (for cap=10 check)
  const betCountCache = new Map<string, number>();
  async function getBetCount(cid: string): Promise<number> {
    if (betCountCache.has(cid)) return betCountCache.get(cid)!;
    const r = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(signalsTable)
      .where(
        and(
          eq(signalsTable.strategyId, strategy.id),
          eq(signalsTable.marketCid, cid),
          eq(signalsTable.decision, "bet"),
        ),
      );
    const c = r[0]?.c ?? 0;
    betCountCache.set(cid, c);
    return c;
  }

  // Sort trades by timestamp ascending (cap=10 chronological check)
  decoded.sort((a, b) => a.timestamp - b.timestamp);

  for (const trade of decoded) {
    if (trade.timestamp <= (strategy.lastPollTs ?? 0)) {
      // Already past our cursor — defensive
      continue;
    }
    // Skip our own (impossible in paper-trade) trades. No-op.

    // Find the market metadata. Either from DB or activity lookup.
    const mr = await db
      .select()
      .from(markets)
      .where(eq(markets.conditionId, trade.conditionId))
      .limit(1);
    let marketRow = mr[0];

    if (!marketRow) {
      // We have a token cache hit (otherwise we wouldn't have decoded), so
      // the upsert in step 5 of runOnce already wrote this market — re-read.
      const re = await db
        .select()
        .from(markets)
        .where(eq(markets.conditionId, trade.conditionId))
        .limit(1);
      marketRow = re[0];
    }

    const category = marketRow?.category ?? null;
    const resolutionTs = marketRow?.resolutionTimestamp ?? null;
    const resolved = marketRow?.resolved ?? 0;

    // Strategy filter
    const decision = evaluateTrade({
      trade: {
        rawTradeId: trade.rawTradeId,
        conditionId: trade.conditionId,
        wallet: trade.wallet,
        side: trade.side,
        outcomeIdx: trade.outcomeIdx,
        price: trade.price,
        timestamp: trade.timestamp,
      },
      marketResolutionTs: resolutionTs,
      marketCategory: resolved ? null : category,
      marketBetCount: await getBetCount(trade.conditionId),
      cash,
      stake: strategy.stake,
      params: STRATEGY.params,
    });

    // Insert signal (idempotent on (strategyId, rawTradeId))
    let signalId: number | null = null;
    try {
      const ins = await db
        .insert(signalsTable)
        .values({
          strategyId: strategy.id,
          marketCid: trade.conditionId,
          rawTradeId: trade.rawTradeId,
          rawWallet: trade.wallet,
          rawTs: trade.timestamp,
          rawSide: trade.side,
          rawPrice: trade.price,
          rawOutcomeIdx: trade.outcomeIdx,
          decision: decision.action,
          reason: decision.reason,
          entryPrice: decision.entryPrice ?? null,
          betOutcome: decision.betOutcome ?? null,
        })
        .returning({ id: signalsTable.id });
      signalId = ins[0]?.id ?? null;
    } catch (e) {
      // Likely unique-constraint duplicate; just skip
      const msg = (e as Error).message || "";
      if (msg.toLowerCase().includes("duplicate") || msg.toLowerCase().includes("unique")) {
        nDuplicates += 1;
        continue;
      }
      throw e;
    }

    if (decision.action === "bet" && signalId != null) {
      await db.insert(positionsTable).values({
        strategyId: strategy.id,
        signalId,
        marketCid: trade.conditionId,
        side: trade.side,
        entryPrice: decision.entryPrice,
        betOutcome: decision.betOutcome,
        stake: strategy.stake,
        entryTs: trade.timestamp,
        plannedResolutionTs: resolutionTs,
      });
      cash -= strategy.stake;
      cashSpent += strategy.stake;
      nBetsAdded += 1;
      betCountCache.set(trade.conditionId, (betCountCache.get(trade.conditionId) ?? 0) + 1);
    } else {
      nSkipped += 1;
    }
  }

  if (cashSpent > 0) {
    await db
      .update(strategies)
      .set({
        currentCash: sql`${strategies.currentCash} - ${cashSpent}`,
        updatedAt: new Date(),
      })
      .where(eq(strategies.id, strategy.id));
  }

  return { nBetsAdded, nSkipped, nDuplicates };
}

async function runOnce(): Promise<{
  ok: boolean;
  strategies_processed: number;
  trades_fetched: number;
  trades_decoded: number;
  bets_placed: number;
  signals_skipped: number;
  duplicates_skipped: number;
  positions_settled: number;
  cash_settled_in: number;
}> {
  const strategiesList = await loadActiveStrategies();
  if (strategiesList.length === 0) {
    return {
      ok: true,
      strategies_processed: 0,
      trades_fetched: 0,
      trades_decoded: 0,
      bets_placed: 0,
      signals_skipped: 0,
      duplicates_skipped: 0,
      positions_settled: 0,
      cash_settled_in: 0,
    };
  }

  // Pick the earliest cursor across strategies; ensures all strategies see
  // every trade since their last successful poll.
  const cursor = strategiesList.reduce<number>(
    (acc, s) => Math.min(acc, s.lastPollTs ?? NOW_S() - 5 * 60),
    NOW_S(),
  );
  const safeCursor = cursor > 0 ? cursor : NOW_S() - 5 * 60;

  // Fetch new trades. Cap at 2000 / 4 pages to keep within the 300s budget.
  const raw = await fetchTradesSince({ sinceTs: safeCursor, maxRows: 2000, maxPages: 4 });

  // Step 1: collect distinct token ids that need lookup
  const tokensToLookup = new Set<string>();
  for (const r of raw) {
    if (r.makerAssetId === "0") tokensToLookup.add(r.takerAssetId);
    else if (r.takerAssetId === "0") tokensToLookup.add(r.makerAssetId);
  }
  // Drop tokens already in cache (no-op on cold start, but cheap)
  for (const t of tokensToLookup) if (tokenCache.has(t)) tokensToLookup.delete(t);

  // Step 2: batch-fetch token -> market mappings
  const tokenMap = await fetchMarketsForTokens({ tokenIds: Array.from(tokensToLookup) });

  // Step 3: collect distinct conditionIds that need resolution metadata
  const conditionIdsNeedingMeta = new Set<string>();
  for (const m of tokenMap.values()) conditionIdsNeedingMeta.add(m.conditionId);
  // Drop conditionIds already known in DB with resolution_ts populated
  if (conditionIdsNeedingMeta.size > 0) {
    const existing = await db
      .select({
        cid: markets.conditionId,
        resTs: markets.resolutionTimestamp,
      })
      .from(markets)
      .where(sql`${markets.conditionId} = ANY(${Array.from(conditionIdsNeedingMeta)})`);
    for (const { cid, resTs } of existing) {
      if (resTs != null) conditionIdsNeedingMeta.delete(cid);
    }
  }

  // Step 4: batch-fetch resolution metadata
  const metaMap =
    conditionIdsNeedingMeta.size > 0
      ? await fetchMarketMetadataBatch({ conditionIds: Array.from(conditionIdsNeedingMeta) })
      : new Map();

  // Step 5: persist new market rows + populate cache
  for (const [tokenId, mm] of tokenMap.entries()) {
    const meta = metaMap.get(mm.conditionId);
    // Look up existing DB row to preserve category/question
    const existing = await db
      .select()
      .from(markets)
      .where(eq(markets.conditionId, mm.conditionId))
      .limit(1);
    const exRow = existing[0];
    const category = exRow?.category ?? null;
    const resolutionTs = meta?.resolutionTimestamp ?? exRow?.resolutionTimestamp ?? null;
    const winnerIdx = meta?.winnerOutcomeIdx ?? exRow?.winnerOutcomeIdx ?? null;
    const payouts = meta?.payouts ?? (exRow?.payoutsJson ?? null);
    const resolved: 0 | 1 = winnerIdx != null ? 1 : ((exRow?.resolved ?? 0) as 0 | 1);

    if (!exRow || meta != null) {
      await db
        .insert(markets)
        .values({
          conditionId: mm.conditionId,
          category,
          resolutionTimestamp: resolutionTs,
          payoutsJson: payouts as string[] | null,
          resolved,
          winnerOutcomeIdx: winnerIdx,
        })
        .onConflictDoUpdate({
          target: markets.conditionId,
          set: {
            resolutionTimestamp: resolutionTs,
            payoutsJson: payouts as string[] | null,
            resolved,
            winnerOutcomeIdx: winnerIdx,
            updatedAt: new Date(),
          },
        });
    }
    tokenCache.set(tokenId, {
      conditionId: mm.conditionId,
      category,
      resolutionTimestamp: resolutionTs,
      resolved,
      winnerOutcomeIdx: winnerIdx,
      outcomeIdx: mm.outcomeIdx,
    });
  }

  // Step 6: decode trades
  const decoded: DecodedTrade[] = [];
  for (const r of raw) {
    let tokenId: string | null = null;
    if (r.makerAssetId === "0") tokenId = r.takerAssetId;
    else if (r.takerAssetId === "0") tokenId = r.makerAssetId;
    if (!tokenId) continue;
    const market = tokenCache.get(tokenId);
    if (!market) continue;
    const t = decodeTrade(
      r,
      new Map([
        [tokenId, { conditionId: market.conditionId, outcomeIdx: market.outcomeIdx }],
      ]),
    );
    if (t) decoded.push(t);
  }

  // For each strategy: process trades, settle resolved, snapshot
  let totalBets = 0;
  let totalSkipped = 0;
  let totalDup = 0;
  let totalSettled = 0;
  let totalSettleCash = 0;
  let maxNewCursor = safeCursor;
  for (const r of raw) {
    const ts = Number(r.timestamp);
    if (Number.isFinite(ts) && ts > maxNewCursor) maxNewCursor = ts;
  }

  for (const strat of strategiesList) {
    const stratView = { ...strat, currentCash: Number(strat.currentCash) };
    const { nBetsAdded, nSkipped, nDuplicates } = await processStrategyForTrades({
      strategy: stratView,
      decoded,
    });
    const settled = await settleResolvedOpenPositions({
      strategyId: strat.id,
      slippage: STRATEGY.params.slippage,
    });
    await takeDailySnapshot(strat.id);

    totalBets += nBetsAdded;
    totalSkipped += nSkipped;
    totalDup += nDuplicates;
    totalSettled += settled.settled;
    totalSettleCash += settled.cashDelta;

    await db
      .update(strategies)
      .set({ lastPollTs: maxNewCursor, updatedAt: new Date() })
      .where(eq(strategies.id, strat.id));
  }

  return {
    ok: true,
    strategies_processed: strategiesList.length,
    trades_fetched: raw.length,
    trades_decoded: decoded.length,
    bets_placed: totalBets,
    signals_skipped: totalSkipped,
    duplicates_skipped: totalDup,
    positions_settled: totalSettled,
    cash_settled_in: totalSettleCash,
  };
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const t0 = Date.now();
  try {
    const result = await runOnce();
    const elapsedMs = Date.now() - t0;
    console.log(`[cron] poll done in ${elapsedMs}ms`, result);
    return NextResponse.json({ ...result, elapsed_ms: elapsedMs });
  } catch (e) {
    const elapsedMs = Date.now() - t0;
    console.error(`[cron] poll FAILED after ${elapsedMs}ms`, e);
    return NextResponse.json(
      { ok: false, error: (e as Error).message, elapsed_ms: elapsedMs },
      { status: 500 },
    );
  }
}

// Allow POST for manual triggers / Vercel Cron (which can use either method).
export const POST = GET;
