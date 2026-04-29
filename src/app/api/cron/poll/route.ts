// Vercel Cron handler — polls Goldsky for new trades and applies each ACTIVE
// strategy's filter. Daily on Hobby plan; bump to */5 after Pro upgrade.
//
// Logic:
//   1. Load active strategies and their last_poll_ts cursors.
//   2. Use the EARLIEST cursor across strategies as the global fetch floor.
//   3. Fetch new orderFilledEvents since cursor from the orderbook subgraph.
//   4. Decode each trade -> (conditionId, outcomeIdx, price, ts, notionalUsd).
//   5. Sort decoded trades chronologically (older first).
//   6. For EACH trade, in order:
//      a. For each active strategy: evaluate, write Signal + (if bet) Position.
//         Each strategy reads market_running_volume_usdc as it was BEFORE this
//         trade.
//      b. After all strategies have evaluated, BUMP markets.running_volume_usdc
//         by this trade's notionalUsd. (So the NEXT trade's pre-trade volume
//         includes this one.)
//   7. Settle resolved positions per strategy.
//   8. Take a daily snapshot per strategy.
//
// NO real-money execution. Paper-money only.

import { NextResponse } from "next/server";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  dailySnapshots,
  marketCatalysts,
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
import {
  evaluateTrade,
  settlePosition,
  type StrategyParams,
} from "@/lib/strategy";
import { classifyMany, lookupStaticLabel } from "@/lib/classify";
import {
  fetchMarketsByConditions,
  parseEndTs,
  GammaUnreachableError,
} from "@/lib/gamma";

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
  if (req.headers.get("x-vercel-cron-signature")) return true;
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") || "";
    if (auth === `Bearer ${secret}`) return true;
    return false;
  }
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

  const [strat] = await db.select().from(strategies).where(eq(strategies.id, strategyId));
  if (!strat) return;
  const openRows = await db
    .select({ stake: positionsTable.stake })
    .from(positionsTable)
    .where(and(eq(positionsTable.strategyId, strategyId), isNull(positionsTable.settledTs)));
  const closedRows = await db
    .select({ payout: positionsTable.payout, stake: positionsTable.stake })
    .from(positionsTable)
    .where(
      and(eq(positionsTable.strategyId, strategyId), sql`${positionsTable.settledTs} is not null`),
    );
  const nBetsTotal =
    (
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

type StrategyRuntimeState = {
  strategy: Strategy;
  params: StrategyParams;
  cash: number;
  betCountByMarket: Map<string, number>;
  /** Counters for the cron summary. */
  nBetsAdded: number;
  nSkipped: number;
  nDuplicates: number;
  cashSpent: number;
};

async function buildRuntimeState(strat: Strategy): Promise<StrategyRuntimeState> {
  return {
    strategy: strat,
    params: strat.paramsJson as unknown as StrategyParams,
    cash: Number(strat.currentCash),
    betCountByMarket: new Map(),
    nBetsAdded: 0,
    nSkipped: 0,
    nDuplicates: 0,
    cashSpent: 0,
  };
}

async function getBetCount(state: StrategyRuntimeState, cid: string): Promise<number> {
  const cached = state.betCountByMarket.get(cid);
  if (cached != null) return cached;
  const r = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(signalsTable)
    .where(
      and(
        eq(signalsTable.strategyId, state.strategy.id),
        eq(signalsTable.marketCid, cid),
        eq(signalsTable.decision, "bet"),
      ),
    );
  const c = r[0]?.c ?? 0;
  state.betCountByMarket.set(cid, c);
  return c;
}

/**
 * For one trade and one strategy, evaluate, write the signal, and (if bet)
 * write the position + decrement cash.
 */
async function processStrategyTrade(args: {
  state: StrategyRuntimeState;
  trade: DecodedTrade;
  marketResolutionTs: number | null;
  marketCategory: string | null;
  marketRunningVolumeUsdc: number;
  marketCatalystTs: number | null;
  marketCatalystSource: string | null;
  marketQuestionText: string | null;
}): Promise<void> {
  const {
    state,
    trade,
    marketResolutionTs,
    marketCategory,
    marketRunningVolumeUsdc,
    marketCatalystTs,
    marketCatalystSource,
    marketQuestionText,
  } = args;

  if (trade.timestamp <= (state.strategy.lastPollTs ?? 0)) {
    // Already past our cursor — defensive
    return;
  }

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
    marketResolutionTs,
    marketCategory,
    marketRunningVolumeUsdc,
    marketBetCount: await getBetCount(state, trade.conditionId),
    marketCatalystTs,
    marketCatalystSource,
    marketQuestionText,
    cash: state.cash,
    stake: state.strategy.stake,
    params: state.params,
  });

  // Insert signal (idempotent on (strategyId, rawTradeId))
  let signalId: number | null = null;
  try {
    const ins = await db
      .insert(signalsTable)
      .values({
        strategyId: state.strategy.id,
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
    const msg = (e as Error).message || "";
    if (msg.toLowerCase().includes("duplicate") || msg.toLowerCase().includes("unique")) {
      state.nDuplicates += 1;
      return;
    }
    throw e;
  }

  if (decision.action === "bet" && signalId != null) {
    await db.insert(positionsTable).values({
      strategyId: state.strategy.id,
      signalId,
      marketCid: trade.conditionId,
      side: trade.side,
      entryPrice: decision.entryPrice,
      betOutcome: decision.betOutcome,
      stake: state.strategy.stake,
      entryTs: trade.timestamp,
      plannedResolutionTs: marketResolutionTs,
    });
    state.cash -= state.strategy.stake;
    state.cashSpent += state.strategy.stake;
    state.nBetsAdded += 1;
    state.betCountByMarket.set(
      trade.conditionId,
      (state.betCountByMarket.get(trade.conditionId) ?? 0) + 1,
    );
  } else {
    state.nSkipped += 1;
  }
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
  per_strategy: Array<{
    id: string;
    bets: number;
    skipped: number;
    duplicates: number;
    settled: number;
    cash_settled_in: number;
  }>;
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
      per_strategy: [],
    };
  }

  // Earliest cursor across strategies — ensures every strategy sees every trade.
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
  for (const t of tokensToLookup) if (tokenCache.has(t)) tokensToLookup.delete(t);

  // Step 2: batch-fetch token -> market mappings
  const tokenMap = await fetchMarketsForTokens({ tokenIds: Array.from(tokensToLookup) });

  // Step 3: collect distinct conditionIds that need resolution metadata
  const conditionIdsNeedingMeta = new Set<string>();
  for (const m of tokenMap.values()) conditionIdsNeedingMeta.add(m.conditionId);
  if (conditionIdsNeedingMeta.size > 0) {
    const ids = Array.from(conditionIdsNeedingMeta);
    const existing = await db
      .select({
        cid: markets.conditionId,
        resTs: markets.resolutionTimestamp,
      })
      .from(markets)
      .where(inArray(markets.conditionId, ids));
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

  // Step 5b: lazy-classify newly-seen markets that still have category=null.
  //
  // The original behavior here was: row gets created with category=null, every
  // strategy then skips with "market not in tradeable_*". To unblock this:
  //   1. Try the static label index (free, ~15.5K markets in the research
  //      tradability parquet).
  //   2. If still null, batch-fetch question text from Gamma for the unique
  //      newly-seen condition_ids and classify with Claude Haiku 4.5
  //      (~$0.0001/market, capped at $5/run).
  //   3. Update the markets row in-place. Also patch the tokenCache so the
  //      strategies in this same cron invocation see the category.
  //
  // Cost ceiling: at typical 15-min poll cadence we see <100 new markets per
  // run; budget is generous.
  const cidsNeedingCategory = new Set<string>();
  for (const entry of tokenCache.values()) {
    if (!entry) continue;
    if (entry.category != null) continue;
    cidsNeedingCategory.add(entry.conditionId);
  }
  // Also pull in any existing markets in the DB that we touched this poll
  // and that still have category=null. (Avoids classifying the same market
  // every poll cycle via tokenCache being process-local.)
  if (cidsNeedingCategory.size > 0) {
    const existingNullCat = await db
      .select({ cid: markets.conditionId })
      .from(markets)
      .where(
        and(
          inArray(markets.conditionId, Array.from(cidsNeedingCategory)),
          isNull(markets.category),
        ),
      );
    const stillNull = new Set(existingNullCat.map((r) => r.cid));
    // Drop any cids that now have category in DB (someone else classified)
    for (const cid of Array.from(cidsNeedingCategory)) {
      if (!stillNull.has(cid)) cidsNeedingCategory.delete(cid);
    }
  }
  console.log(
    `[cron] lazy-classify: ${cidsNeedingCategory.size} markets need category`,
  );
  // Free pass via static label index first.
  const lazyResolutions = new Map<string, { category: string | null; endTs: number | null }>();
  for (const cid of cidsNeedingCategory) {
    const cat = lookupStaticLabel(cid);
    if (cat) {
      lazyResolutions.set(cid, { category: cat, endTs: null });
    }
  }
  // LLM-classify the rest if Anthropic key + Gamma reachable.
  const stillUnclassified = Array.from(cidsNeedingCategory).filter(
    (c) => !lazyResolutions.has(c),
  );
  console.log(
    `[cron] lazy-classify: ${lazyResolutions.size} from static labels, ${stillUnclassified.length} need Gamma+LLM`,
  );
  if (stillUnclassified.length > 0 && process.env.ANTHROPIC_API_KEY) {
    try {
      // Batch-fetch question text + endDate from Gamma.
      const gammaMap = await fetchMarketsByConditions({
        conditionIds: stillUnclassified,
      });
      const llmInput: Array<{ conditionId: string; question: string | null }> = [];
      for (const cid of stillUnclassified) {
        const g = gammaMap.get(cid);
        if (!g) continue;
        const endTs = parseEndTs(g.endDate);
        // Stash endTs early so we update resolution_timestamp even if LLM
        // call fails or times out.
        lazyResolutions.set(cid, { category: null, endTs });
        if ((g.question ?? "").trim()) {
          llmInput.push({ conditionId: cid, question: g.question });
        }
      }
      if (llmInput.length > 0) {
        const llmOut = await classifyMany({
          items: llmInput,
          concurrency: 8,
          // Lower budget per poll (we run every 15 min) than per sync (every 6h).
          budgetUsd: 1,
        });
        for (const [cid, cat] of llmOut.entries()) {
          const prev = lazyResolutions.get(cid) ?? { category: null, endTs: null };
          lazyResolutions.set(cid, { category: cat, endTs: prev.endTs });
        }
      }
    } catch (e) {
      if (e instanceof GammaUnreachableError) {
        console.warn(`[cron] gamma unreachable for lazy-classify; skipping LLM step`);
      } else {
        console.warn(`[cron] lazy-classify failed:`, (e as Error).message);
      }
    }
  }
  // Persist the resolved categories + resolution timestamps. Also patch
  // tokenCache so strategies see the category in this same invocation.
  for (const [cid, info] of lazyResolutions.entries()) {
    if (info.category == null && info.endTs == null) continue;
    await db
      .update(markets)
      .set({
        category: info.category != null ? info.category : sql`${markets.category}`,
        resolutionTimestamp:
          info.endTs != null
            ? sql`coalesce(${markets.resolutionTimestamp}, ${info.endTs})`
            : sql`${markets.resolutionTimestamp}`,
        updatedAt: new Date(),
      })
      .where(eq(markets.conditionId, cid));
    for (const entry of tokenCache.values()) {
      if (!entry) continue;
      if (entry.conditionId !== cid) continue;
      if (info.category != null) entry.category = info.category;
      if (info.endTs != null && entry.resolutionTimestamp == null)
        entry.resolutionTimestamp = info.endTs;
    }
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
      new Map([[tokenId, { conditionId: market.conditionId, outcomeIdx: market.outcomeIdx }]]),
    );
    if (t) decoded.push(t);
  }

  // Sort decoded chronologically (older first) — required for cap=N and for
  // running-volume tracking to be meaningful.
  decoded.sort((a, b) => a.timestamp - b.timestamp);

  // Step 7: build runtime state per strategy and load market metadata once
  const states = await Promise.all(strategiesList.map(buildRuntimeState));

  // Pre-load market metadata for all unique conditionIds in this batch.
  const uniqueCids = Array.from(new Set(decoded.map((t) => t.conditionId)));
  const marketMetaCache = new Map<
    string,
    {
      category: string | null;
      resolutionTs: number | null;
      resolved: number;
      runningVolumeUsdc: number;
      questionText: string | null;
    }
  >();
  if (uniqueCids.length > 0) {
    const rows = await db
      .select()
      .from(markets)
      .where(inArray(markets.conditionId, uniqueCids));
    for (const m of rows) {
      marketMetaCache.set(m.conditionId, {
        category: m.category ?? null,
        resolutionTs: m.resolutionTimestamp ?? null,
        resolved: m.resolved ?? 0,
        runningVolumeUsdc: Number(m.runningVolumeUsdc ?? 0),
        questionText: m.questionText ?? null,
      });
    }
  }

  // Pre-load catalyst timestamps + sources for all unique conditionIds. Only
  // loaded if any active strategy actually uses `require_future_catalyst`
  // (avoids a useless query when no one needs it).
  const anyStrategyNeedsCatalyst = states.some(
    (s) => s.params.require_future_catalyst === true,
  );
  const catalystCache = new Map<
    string,
    { ts: number; source: string | null }
  >();
  if (anyStrategyNeedsCatalyst && uniqueCids.length > 0) {
    const catRows = await db
      .select({
        cid: marketCatalysts.conditionId,
        ts: marketCatalysts.catalystTs,
        source: marketCatalysts.catalystSource,
      })
      .from(marketCatalysts)
      .where(inArray(marketCatalysts.conditionId, uniqueCids));
    for (const { cid, ts, source } of catRows) {
      if (ts != null)
        catalystCache.set(cid, { ts: Number(ts), source: source ?? null });
    }
  }

  // Step 8: walk trades chronologically.
  // For each trade: every strategy evaluates against the PRE-trade running
  // volume. Then we bump the running volume by the trade's notional.
  for (const trade of decoded) {
    const meta = marketMetaCache.get(trade.conditionId);
    const runningVolBefore = meta?.runningVolumeUsdc ?? 0;
    const category = meta?.resolved ? null : meta?.category ?? null;
    const resolutionTs = meta?.resolutionTs ?? null;
    const questionText = meta?.questionText ?? null;
    const catalystEntry = catalystCache.get(trade.conditionId);
    const catalystTs = catalystEntry?.ts ?? null;
    const catalystSource = catalystEntry?.source ?? null;

    for (const state of states) {
      await processStrategyTrade({
        state,
        trade,
        marketResolutionTs: resolutionTs,
        marketCategory: category,
        marketRunningVolumeUsdc: runningVolBefore,
        marketCatalystTs: catalystTs,
        marketCatalystSource: catalystSource,
        marketQuestionText: questionText,
      });
    }

    // Bump in-process cache and persist running volume.
    const newVol = runningVolBefore + Number(trade.notionalUsd || 0);
    if (meta) meta.runningVolumeUsdc = newVol;
    else
      marketMetaCache.set(trade.conditionId, {
        category: null,
        resolutionTs: null,
        resolved: 0,
        runningVolumeUsdc: newVol,
        questionText: null,
      });
  }

  // Persist running-volume updates (one update per touched market)
  for (const cid of uniqueCids) {
    const m = marketMetaCache.get(cid);
    if (!m) continue;
    await db
      .update(markets)
      .set({
        runningVolumeUsdc: m.runningVolumeUsdc,
        updatedAt: new Date(),
      })
      .where(eq(markets.conditionId, cid));
  }

  // Step 9: persist cash deltas, settle resolved, take snapshot, advance cursor
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

  const perStrategySummary: Array<{
    id: string;
    bets: number;
    skipped: number;
    duplicates: number;
    settled: number;
    cash_settled_in: number;
  }> = [];

  for (const state of states) {
    if (state.cashSpent > 0) {
      await db
        .update(strategies)
        .set({
          currentCash: sql`${strategies.currentCash} - ${state.cashSpent}`,
          updatedAt: new Date(),
        })
        .where(eq(strategies.id, state.strategy.id));
    }

    const settled = await settleResolvedOpenPositions({
      strategyId: state.strategy.id,
      slippage: state.params.slippage,
    });
    await takeDailySnapshot(state.strategy.id);

    totalBets += state.nBetsAdded;
    totalSkipped += state.nSkipped;
    totalDup += state.nDuplicates;
    totalSettled += settled.settled;
    totalSettleCash += settled.cashDelta;

    perStrategySummary.push({
      id: state.strategy.id,
      bets: state.nBetsAdded,
      skipped: state.nSkipped,
      duplicates: state.nDuplicates,
      settled: settled.settled,
      cash_settled_in: settled.cashDelta,
    });

    await db
      .update(strategies)
      .set({ lastPollTs: maxNewCursor, updatedAt: new Date() })
      .where(eq(strategies.id, state.strategy.id));
  }

  // Also advance cursor on retired strategies (they shouldn't fall behind in
  // case they're re-activated; but they don't accumulate signals).
  await db
    .update(strategies)
    .set({ lastPollTs: maxNewCursor, updatedAt: new Date() })
    .where(ne(strategies.status, "active"));

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
    per_strategy: perStrategySummary,
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
