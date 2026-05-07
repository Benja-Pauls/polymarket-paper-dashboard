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
  forwardOosValidations,
  marketCatalysts,
  markets,
  positions as positionsTable,
  signals as signalsTable,
  strategies,
  type Strategy,
} from "@/lib/db/schema";
import {
  fetchMarketMetadata,
  fetchMarketMetadataBatch,
  type DecodedTrade,
} from "@/lib/goldsky";
import { fetchClobMarket } from "@/lib/clob";
import { fetchTradesSinceFromDataApi } from "@/lib/trades";
import {
  evaluateTrade,
  settlePosition,
  type StrategyParams,
} from "@/lib/strategy";
import { classifyMany, lookupStaticLabel } from "@/lib/classify";
import { recordCronRun } from "@/lib/cron-tracker";
import { evaluateBet, coldStartDampFactor } from "@/lib/llm-evaluator";

export const runtime = "nodejs";
export const maxDuration = 300; // 5 minutes
export const dynamic = "force-dynamic";

const NOW_S = () => Math.floor(Date.now() / 1000);

// Skip-signal log policy.
//
// 2026-05-03: hit Neon's 512 MB project cap. The `signals` table was 461 MB
// (94% of the DB), 685K rows, of which only 654 were `decision='bet'` (the
// rows we actually use — positions FK them, edge-rate dashboard aggregates
// them). The other 99.9% were skip-decision rows that we never read
// programmatically; they were intended as debug breadcrumbs but the volume
// (~30K/hour) was overwhelming the prune-signals cron's 24h retention.
//
// The fix: by default, do NOT INSERT skip signals to DB — emit a structured
// console log line instead. Vercel runtime logs retain the same info for
// ad-hoc debugging (greppable: `[skip] strategy=... cid=... reason=...`).
//
// To re-enable DB writes for skip signals (e.g. for one-off forensics),
// set LOG_SKIP_SIGNALS_TO_DB=true in Vercel env vars.
const LOG_SKIP_SIGNALS_TO_DB = process.env.LOG_SKIP_SIGNALS_TO_DB === "true";

type MarketCacheEntry = {
  conditionId: string;
  category: string | null;
  resolutionTimestamp: number | null;
  resolved: 0 | 1;
  winnerOutcomeIdx: number | null;
};

// In-process conditionId -> market cache. Survives within one cron invocation.
const marketCache = new Map<string, MarketCacheEntry | null>();

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
  const all = await db
    .select()
    .from(strategies)
    .where(eq(strategies.status, "active"));

  // Process fix #1 (2026-05-01): forward-OOS validation gate. Strategies
  // with `requires_oos_validation=true` in their params (set by post-2026-05-01
  // strategies as a hard deploy gate) are skipped if no validation row exists
  // within the last 14 days. Existing strategies (baseline_v1, etc.) are
  // grandfathered without this flag and continue normally.
  //
  // Prevents another v12 process error: I deployed v12 live before forward-OOS
  // validation finished. With this gate, that's not possible anymore — the
  // strategy is silently skipped until its validation row exists.
  const cutoffMs = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const cutoff = new Date(cutoffMs);
  const filtered: Strategy[] = [];
  for (const s of all) {
    const params = (s.paramsJson ?? {}) as Record<string, unknown>;
    if (params.requires_oos_validation === true) {
      const recent = await db
        .select({ id: forwardOosValidations.id })
        .from(forwardOosValidations)
        .where(
          and(
            eq(forwardOosValidations.strategyId, s.id),
            sql`validated_at >= ${cutoff}`,
            eq(forwardOosValidations.overallVerdict, "DEPLOY"),
          ),
        )
        .limit(1);
      if (recent.length === 0) {
        console.warn(
          `[cron] strategy ${s.id} requires_oos_validation=true but no DEPLOY-verdict validation in last 14d; skipping`,
        );
        continue;
      }
    }
    filtered.push(s);
  }
  return filtered;
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
      // Fallback: try to fetch resolution from CLOB. The
      // refresh-position-prices cron already does this proactively every 5
      // min, but this path catches anything it missed (e.g. a market that
      // resolved between two refresh cycles AND poll catches it first).
      // PRIOR BUG (2026-05-07): this used fetchMarketMetadata from Goldsky,
      // which doesn't index post-Jan-5-2026 markets — so resolution was
      // never detected and "real $0" persisted forever. Switched to CLOB.
      try {
        const live = await fetchClobMarket(mkt.conditionId);
        if (live && live.closed && live.winnerOutcomeIdx != null) {
          await db
            .update(markets)
            .set({
              resolutionTimestamp:
                live.resolutionTimestamp ?? mkt.resolutionTimestamp,
              payoutsJson: live.winnerOutcomeIdx === 0 ? ["1", "0"] : ["0", "1"],
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
    // Race-safe UPDATE: `WHERE settled_ts IS NULL` so a concurrent
    // refresh-position-prices settlement can't double-credit. If the row
    // was already settled by the other path, rowCount=0 and we skip.
    const upd = await db
      .update(positionsTable)
      .set({
        won: settle.won,
        payout: settle.payout,
        realizedReturn: settle.realizedReturn,
        settledTs: NOW_S(),
      })
      .where(
        and(
          eq(positionsTable.id, pos.id),
          isNull(positionsTable.settledTs),
        ),
      );
    if (!upd.rowCount || upd.rowCount === 0) {
      // Another path settled this; don't credit cash.
      continue;
    }
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
  marketCreatedAt: number | null;
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
    marketCreatedAt,
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
    marketCreatedAt,
    cash: state.cash,
    stake: state.strategy.stake,
    params: state.params,
  });

  // Skip path: by default, log + return without touching DB. See the
  // LOG_SKIP_SIGNALS_TO_DB note at the top of the file for why.
  // Bet path: insert as before — bet signals are FK-referenced by positions
  // and aggregated by /admin/edge-rate, so they MUST persist.
  let signalId: number | null = null;
  if (decision.action === "skip" && !LOG_SKIP_SIGNALS_TO_DB) {
    // Structured single-line log so ad-hoc grep-in-Vercel-logs still works.
    // Truncate the reason aggressively — at ~30K skips/hour, full reasons
    // would balloon log volume. Operators can re-enable DB writes via the
    // env flag if they need full forensics for a specific strategy.
    console.log(
      `[skip] strategy=${state.strategy.id} cid=${trade.conditionId.slice(0, 10)} reason=${decision.reason.slice(0, 80)}`,
    );
    state.nSkipped += 1;
    return;
  }

  // Insert signal (idempotent on (strategyId, rawTradeId)).
  // Reaches here only for `decision.action === "bet"` OR when
  // LOG_SKIP_SIGNALS_TO_DB is on.
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
    // v12 LLM-evaluator hook: when the strategy opts in, run a Haiku
    // probability estimate on this candidate bet and adjust the stake by
    // the Kelly fraction. Falls back to flat staking on any error so the
    // live cron never gets stuck on an LLM outage.
    let stakeMultiplier = 1.0;
    let llmDecision: "bet" | "skip" = "bet";
    let llmRationale: string | null = null;
    if (state.params.llm_evaluator_enabled === true) {
      try {
        const hoursToRes =
          marketResolutionTs != null
            ? (marketResolutionTs - trade.timestamp) / 3600
            : 24 * 30;
        const evalResult = await evaluateBet({
          question: marketQuestionText ?? "(unknown)",
          category: marketCategory,
          entryPrice: decision.entryPrice ?? trade.price,
          betOutcome: (decision.betOutcome ?? trade.outcomeIdx) as 0 | 1,
          hoursToResolution: hoursToRes,
          marketRunningVolumeUsdc: marketRunningVolumeUsdc,
        });
        if (evalResult) {
          // Process-fix #2 (2026-05-01): cold-start Kelly cap damps the
          // multiplier in the strategy's first 30 days. Prevents another
          // v12-style "in-sample lift looked great, OOS catastrophic" near-miss
          // — even if the LLM emits a 2.0× confident multiplier, we can't go
          // above 1.0× for 30 days. After 30 days of live data, full Kelly.
          const damp = coldStartDampFactor(state.strategy.createdAt ?? null);
          stakeMultiplier = evalResult.stakeMultiplier * damp;
          llmDecision = evalResult.decision;
          llmRationale =
            damp < 1.0
              ? `[cold-start-damp ${damp}x] ${evalResult.rationale}`
              : evalResult.rationale;
        }
      } catch (e) {
        // Don't block the cron on LLM errors — log + flat-stake fallback.
        console.warn(
          `[v12 evaluator] error on ${trade.conditionId.slice(0, 8)}:`,
          (e as Error).message,
        );
      }
    }

    if (llmDecision === "skip") {
      state.nSkipped += 1;
      // Update the signal's reason so the dashboard shows the LLM rationale.
      try {
        await db
          .update(signalsTable)
          .set({
            decision: "skip",
            reason: `llm-evaluator skip: ${llmRationale ?? "negative edge"}`,
          })
          .where(eq(signalsTable.id, signalId));
      } catch {
        // Non-fatal; the original "bet" decision was already recorded.
      }
      return;
    }

    const adjustedStake = state.strategy.stake * stakeMultiplier;
    await db.insert(positionsTable).values({
      strategyId: state.strategy.id,
      signalId,
      marketCid: trade.conditionId,
      side: trade.side,
      entryPrice: decision.entryPrice,
      betOutcome: decision.betOutcome,
      stake: adjustedStake,
      entryTs: trade.timestamp,
      plannedResolutionTs: marketResolutionTs,
    });
    // Atomically debit cash on the strategies row right after the position
    // insert. The previous design accumulated `cashSpent` in JS memory and
    // applied a bulk UPDATE at the end of the cron run — but if the cron
    // crashed mid-trade-loop (e.g. during the 2026-04-30 Neon-cap incident
    // where signal INSERTs started failing), positions were persisted but
    // the cash UPDATE never fired, leaving a phantom $X credit. The
    // wave9_mirror_geo_v1 strategy ended up $50 over expected (5 × $10
    // stake). Per-position UPDATE keeps cash honest if the loop is
    // interrupted at any point.
    await db
      .update(strategies)
      .set({
        currentCash: sql`${strategies.currentCash} - ${adjustedStake}`,
        updatedAt: new Date(),
      })
      .where(eq(strategies.id, state.strategy.id));
    state.cash -= adjustedStake;
    state.cashSpent += adjustedStake;
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
  // LLM-cost rollup fields. classified-via-Haiku numbers are aggregated by
  // /admin/llm-cost (sum across recent cron_runs.result_json) so we can see
  // monthly spend at a glance without instrumenting Anthropic billing.
  lazy_llm_calls_attempted: number;
  lazy_llm_calls_completed: number;
  lazy_llm_cost_usd: number;
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
      lazy_llm_calls_attempted: 0,
      lazy_llm_calls_completed: 0,
      lazy_llm_cost_usd: 0,
      per_strategy: [],
    };
  }

  // Earliest cursor across strategies — ensures every strategy sees every trade.
  const cursor = strategiesList.reduce<number>(
    (acc, s) => Math.min(acc, s.lastPollTs ?? NOW_S() - 5 * 60),
    NOW_S(),
  );
  const safeCursor = cursor > 0 ? cursor : NOW_S() - 5 * 60;

  // Fetch new trades from Polymarket data-api. Returns DecodedTrade[] directly
  // (with conditionId + outcomeIdx). No token-id reverse lookup needed.
  // This replaces Goldsky's orderbook subgraph which stalled 34h+ behind
  // real-time on 2026-04-29 (orderFilledEvents stopped advancing while _meta
  // block was current — Goldsky-side indexer issue).
  const decoded = await fetchTradesSinceFromDataApi({
    sinceTs: safeCursor,
    maxRows: 2000,
    maxPages: 4,
  });

  // Step 1: collect distinct conditionIds in this batch and seed marketCache
  // from DB.  Identify which need a metadata fetch (resolution_ts missing).
  const distinctCids = new Set<string>(decoded.map((t) => t.conditionId));
  const cidsNeedingMeta = new Set<string>();
  if (distinctCids.size > 0) {
    const existing = await db
      .select({
        cid: markets.conditionId,
        category: markets.category,
        resTs: markets.resolutionTimestamp,
        resolved: markets.resolved,
        winnerIdx: markets.winnerOutcomeIdx,
      })
      .from(markets)
      .where(inArray(markets.conditionId, Array.from(distinctCids)));
    const existingByCid = new Map(existing.map((r) => [r.cid, r]));
    for (const cid of distinctCids) {
      const ex = existingByCid.get(cid);
      if (ex) {
        marketCache.set(cid, {
          conditionId: cid,
          category: ex.category,
          resolutionTimestamp: ex.resTs,
          resolved: ((ex.resolved as unknown) as 0 | 1) ?? 0,
          winnerOutcomeIdx: ex.winnerIdx,
        });
        if (ex.resTs == null) cidsNeedingMeta.add(cid);
      } else {
        cidsNeedingMeta.add(cid);
        marketCache.set(cid, null); // placeholder
      }
    }
  }

  // Step 2: batch-fetch resolution metadata for newly-seen markets.
  const metaMap =
    cidsNeedingMeta.size > 0
      ? await fetchMarketMetadataBatch({
          conditionIds: Array.from(cidsNeedingMeta),
        })
      : new Map();

  // Step 3: upsert market rows for newly-seen / needing-meta markets and
  // finalize marketCache entries.
  for (const cid of cidsNeedingMeta) {
    const meta = metaMap.get(cid);
    const existing = await db
      .select()
      .from(markets)
      .where(eq(markets.conditionId, cid))
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
          conditionId: cid,
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
    marketCache.set(cid, {
      conditionId: cid,
      category,
      resolutionTimestamp: resolutionTs,
      resolved,
      winnerOutcomeIdx: winnerIdx,
    });
  }

  // Step 5b: lazy-classify newly-seen markets that still have category=null.
  //
  // The original behavior here was: row gets created with category=null, every
  // strategy then skips with "market not in tradeable_*". To unblock this:
  //   1. Try the static label index (free, ~15.5K markets in the research
  //      tradability parquet).
  //   2. If still null, classify with Claude Haiku 4.5 (~$0.0001/market) using
  //      the `title` field that data-api /trades returned for free with each
  //      trade. We previously round-tripped Gamma here but Gamma's
  //      `?conditionIds=` filter is silently ignored (returns random markets)
  //      so 100% of LLM calls were getting null question text and skipping.
  //   3. Persist (category, question_text) onto the markets row. The 6-hour
  //      sync-open-markets cron supplies endDate from Gamma's paginated
  //      `?active=true&closed=false` endpoint (which DOES work).
  //
  // Cost ceiling: at typical 15-min poll cadence we see <500 new markets per
  // run; ANTHROPIC budget cap of $1/poll handles ~5,000 calls.
  const cidsNeedingCategory = new Set<string>();
  for (const entry of marketCache.values()) {
    if (!entry) continue;
    if (entry.category != null) continue;
    cidsNeedingCategory.add(entry.conditionId);
  }
  // Also pull in any existing markets in the DB that we touched this poll
  // and that still have category=null. (Avoids classifying the same market
  // every poll cycle via marketCache being process-local.)
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
  // Build cid -> title map from the trades we just fetched. Pick the longest
  // title we see (some trades have empty titles for legacy reasons).
  const cidToTitle = new Map<string, string>();
  for (const t of decoded) {
    const title = (t.title ?? "").trim();
    if (!title) continue;
    const prev = cidToTitle.get(t.conditionId);
    if (!prev || title.length > prev.length) cidToTitle.set(t.conditionId, title);
  }
  // Free pass via static label index first.
  const lazyResolutions = new Map<
    string,
    { category: string | null; endTs: number | null; question: string | null }
  >();
  for (const cid of cidsNeedingCategory) {
    const cat = lookupStaticLabel(cid);
    const q = cidToTitle.get(cid) ?? null;
    if (cat) {
      lazyResolutions.set(cid, { category: cat, endTs: null, question: q });
    }
  }
  // LLM-classify the rest using the trade-bundled titles. No Gamma round-trip.
  const stillUnclassified = Array.from(cidsNeedingCategory).filter(
    (c) => !lazyResolutions.has(c),
  );
  const llmInput: Array<{ conditionId: string; question: string | null }> = [];
  for (const cid of stillUnclassified) {
    const q = cidToTitle.get(cid);
    if (q) llmInput.push({ conditionId: cid, question: q });
    // Stash question even if no LLM key, so we still persist it.
    lazyResolutions.set(cid, {
      category: null,
      endTs: null,
      question: q ?? null,
    });
  }
  console.log(
    `[cron] lazy-classify: ${lazyResolutions.size - llmInput.length} from static labels, ${llmInput.length} need LLM (out of ${cidsNeedingCategory.size} total need-category)`,
  );
  // Stats for the result_json LLM-cost rollup. The /admin/llm-cost page
  // sums these across recent cron runs to show total spend.
  let lazyLlmCallsAttempted = 0;
  let lazyLlmCallsCompleted = 0;
  let lazyLlmCostUsd = 0;
  if (llmInput.length > 0 && process.env.ANTHROPIC_API_KEY) {
    lazyLlmCallsAttempted = llmInput.length;
    try {
      const llmOut = await classifyMany({
        items: llmInput,
        concurrency: 8,
        // Lower budget per poll (we run every 15 min) than per sync (every 6h).
        budgetUsd: 1,
      });
      lazyLlmCallsCompleted = llmOut.size;
      // Same per-call cost the classifier itself uses internally
      // (src/lib/classify/index.ts COST_PER_CALL = $0.0002). Kept in sync
      // here so the cost dashboard shows real numbers without a DB hop.
      lazyLlmCostUsd = Number((llmOut.size * 0.0002).toFixed(4));
      for (const [cid, cat] of llmOut.entries()) {
        const prev = lazyResolutions.get(cid) ?? {
          category: null,
          endTs: null,
          question: cidToTitle.get(cid) ?? null,
        };
        lazyResolutions.set(cid, { ...prev, category: cat });
      }
    } catch (e) {
      console.warn(`[cron] lazy-classify LLM failed:`, (e as Error).message);
    }
  }
  // Persist the resolved categories + question text. Also patch marketCache
  // so strategies see the category in this same invocation. resolution_ts
  // for these markets comes from the 6h sync-open-markets cron.
  for (const [cid, info] of lazyResolutions.entries()) {
    if (info.category == null && info.question == null && info.endTs == null) continue;
    await db
      .update(markets)
      .set({
        category: info.category != null ? info.category : sql`${markets.category}`,
        questionText:
          info.question != null
            ? sql`coalesce(${markets.questionText}, ${info.question})`
            : sql`${markets.questionText}`,
        resolutionTimestamp:
          info.endTs != null
            ? sql`coalesce(${markets.resolutionTimestamp}, ${info.endTs})`
            : sql`${markets.resolutionTimestamp}`,
        updatedAt: new Date(),
      })
      .where(eq(markets.conditionId, cid));
    const entry = marketCache.get(cid);
    if (entry) {
      if (info.category != null) entry.category = info.category;
      if (info.endTs != null && entry.resolutionTimestamp == null)
        entry.resolutionTimestamp = info.endTs;
    }
  }

  // Step 6 (was decode-from-Goldsky): no-op now — `decoded` is already in
  // DecodedTrade shape from the data-api fetch.  Just sort chronologically.
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
      // Wave-11: when the dashboard FIRST saw the market. Used by the
      // min_market_lifespan_hours filter to detect oracle/resolution-date
      // mismatches.
      createdAt: number | null;
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
        createdAt: m.createdAt ? Math.floor(m.createdAt.getTime() / 1000) : null,
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
    const createdAt = meta?.createdAt ?? null;
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
        marketCreatedAt: createdAt,
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
        createdAt: null,
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
  for (const t of decoded) {
    const ts = Number(t.timestamp);
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
    // Cash debits already applied per-position in processStrategyTrade —
    // the bulk UPDATE that used to live here has been removed to prevent
    // double-debiting. We still track state.cashSpent for the per-strategy
    // summary counter in the cron response.

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
    trades_fetched: decoded.length,
    trades_decoded: decoded.length,
    bets_placed: totalBets,
    signals_skipped: totalSkipped,
    duplicates_skipped: totalDup,
    positions_settled: totalSettled,
    cash_settled_in: totalSettleCash,
    lazy_llm_calls_attempted: lazyLlmCallsAttempted,
    lazy_llm_calls_completed: lazyLlmCallsCompleted,
    lazy_llm_cost_usd: lazyLlmCostUsd,
    per_strategy: perStrategySummary,
  };
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const t0 = Date.now();
  try {
    // recordCronRun wraps the work and persists a row in cron_runs (powers
    // the /admin/crons observability page).
    const result = await recordCronRun("poll", () => runOnce());
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
