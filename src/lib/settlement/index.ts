// Settlement core — shared between the refresh-position-prices cron and
// any backfill scripts. Single source of truth for "is this market resolved
// and how do we credit the cash."
//
// MONEY-CORRECTNESS code. The functions here directly mutate
// strategies.current_cash and positions.payout / realized_return. Read the
// header on src/app/api/cron/refresh-position-prices/route.ts for the bug
// history that led to this fix.
//
// Invariants this module maintains:
//
//   1. A position is settled exactly once. The UPDATE filters on
//      `settled_ts IS NULL` so concurrent settlement attempts (poll cron +
//      refresh cron racing) cannot both credit the same payout.
//
//   2. Cash credits to strategies.current_cash use SQL `+ delta` (relative)
//      not `= prev + delta` (absolute), so concurrent updates from other
//      paths (e.g. poll placing a new bet) cannot clobber the increment.
//
//   3. Each strategy's settlement uses ITS OWN slippage parameter
//      (params_json.slippage). Different strategies on the same resolved
//      market can have different payouts.
//
//   4. CLOB is the SOLE source of resolution truth. Polymarket Gamma's
//      `?conditionIds=` filter is broken (returns default page); Goldsky
//      doesn't index post-Jan-5-2026 markets. Only CLOB's
//      `/markets/<cid>` returns reliable `closed` + `winner` data.

import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  markets,
  positions as positionsTable,
  strategies,
  type Strategy,
} from "@/lib/db/schema";
import { fetchClobMarketsBatch, type ClobMarket } from "@/lib/clob";
import { settlePosition, type StrategyParams } from "@/lib/strategy";

const NOW_S = () => Math.floor(Date.now() / 1000);

export type SettlementSummary = {
  open_position_cids: number;
  clob_returned: number;
  prices_updated: number;
  prices_missing: number;
  markets_newly_resolved: number;
  positions_settled: number;
  cash_credited_total_usd: number;
  cash_credited_by_strategy: Record<string, number>;
  // Specific positions settled (capped at 50 entries to keep result_json small).
  settlements: Array<{
    position_id: number;
    strategy_id: string;
    market_cid: string;
    bet_outcome: number;
    winner_outcome_idx: number;
    won: 0 | 1;
    entry_price: number;
    stake: number;
    payout: number;
    realized_return: number;
  }>;
};

/**
 * The whole pipeline: discover open-position markets, fetch CLOB state for
 * them, refresh prices, detect newly-resolved markets, settle every open
 * position on those markets, credit cash. Idempotent.
 */
export async function refreshAndSettle(): Promise<SettlementSummary> {
  const summary: SettlementSummary = {
    open_position_cids: 0,
    clob_returned: 0,
    prices_updated: 0,
    prices_missing: 0,
    markets_newly_resolved: 0,
    positions_settled: 0,
    cash_credited_total_usd: 0,
    cash_credited_by_strategy: {},
    settlements: [],
  };

  // 1. Distinct cids with at least one open position.
  const rows = await db
    .selectDistinct({ cid: positionsTable.marketCid })
    .from(positionsTable)
    .where(isNull(positionsTable.settledTs));
  const openCids = rows.map((r) => r.cid);
  summary.open_position_cids = openCids.length;
  if (openCids.length === 0) return summary;

  // 2. Batch CLOB fetch (concurrency 8; ~100 markets / ~1s wall).
  const byCid = await fetchClobMarketsBatch({
    conditionIds: openCids,
    concurrency: 8,
  });
  summary.clob_returned = byCid.size;

  // 3. Pre-load strategies for slippage lookup.
  const allStrategies = await db.select().from(strategies);
  const stratById = new Map<string, Strategy>(
    allStrategies.map((s) => [s.id, s]),
  );

  // 4. Process each market: refresh price, then maybe settle.
  const now = new Date();
  for (const cid of openCids) {
    const m = byCid.get(cid.toLowerCase());
    if (!m) continue;

    // Phase A: price refresh.
    if (m.yesPrice == null) {
      summary.prices_missing += 1;
    } else {
      await db
        .update(markets)
        .set({
          currentYesPrice: m.yesPrice,
          priceUpdatedAt: now,
          updatedAt: now,
        })
        .where(sql`${markets.conditionId} = ${cid}`);
      summary.prices_updated += 1;
    }

    // Phase B: settlement (only if CLOB definitively says closed + winner).
    if (!m.closed || m.winnerOutcomeIdx == null) continue;
    await processResolution({ market: m, cid, stratById, summary });
  }

  return summary;
}

/**
 * Mark a market resolved and settle every open position on it. Cash is
 * credited per-strategy. See module-level invariants above.
 */
async function processResolution(args: {
  market: ClobMarket;
  cid: string;
  stratById: Map<string, Strategy>;
  summary: SettlementSummary;
}) {
  const { market: m, cid, stratById, summary } = args;
  const winnerIdx = m.winnerOutcomeIdx!;

  // 1. Mark market resolved if not already. Only counts as "newly resolved"
  //    if the flag actually flipped (rowCount > 0 from filtered UPDATE).
  const updRes = await db
    .update(markets)
    .set({
      resolved: 1,
      winnerOutcomeIdx: winnerIdx,
      payoutsJson: winnerIdx === 0 ? ["1", "0"] : ["0", "1"],
      resolutionTimestamp:
        m.resolutionTimestamp ??
        sql`coalesce(${markets.resolutionTimestamp}, extract(epoch from now())::bigint)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(markets.conditionId, cid),
        sql`(${markets.resolved} = 0 OR ${markets.winnerOutcomeIdx} IS NULL)`,
      ),
    );
  if (updRes.rowCount && updRes.rowCount > 0) {
    summary.markets_newly_resolved += 1;
  }

  // 2. Find every open position on this market and settle each.
  const openPositions = await db
    .select()
    .from(positionsTable)
    .where(
      and(
        eq(positionsTable.marketCid, cid),
        isNull(positionsTable.settledTs),
      ),
    );

  if (openPositions.length === 0) return;

  // Per-strategy cash delta accumulator, applied as ONE UPDATE per strategy.
  const cashDeltaByStrategy = new Map<string, number>();

  for (const pos of openPositions) {
    const strat = stratById.get(pos.strategyId);
    if (!strat) {
      console.warn(
        `[settlement] position ${pos.id} references unknown strategy ${pos.strategyId}; skipping`,
      );
      continue;
    }
    const params = strat.paramsJson as unknown as StrategyParams;
    const slippage = typeof params.slippage === "number" ? params.slippage : 0;

    const settle = settlePosition({
      stake: pos.stake,
      entryPrice: pos.entryPrice,
      betOutcome: pos.betOutcome,
      winner: winnerIdx,
      slippage,
    });

    // Atomic position UPDATE — re-checks settled_ts to prevent double-credit
    // if a concurrent settlement attempt won the race for this row.
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
      // Lost the race; another path already settled this. Don't credit.
      continue;
    }

    cashDeltaByStrategy.set(
      pos.strategyId,
      (cashDeltaByStrategy.get(pos.strategyId) ?? 0) + settle.payout,
    );
    summary.positions_settled += 1;
    summary.cash_credited_total_usd += settle.payout;

    if (summary.settlements.length < 50) {
      summary.settlements.push({
        position_id: pos.id,
        strategy_id: pos.strategyId,
        market_cid: cid,
        bet_outcome: pos.betOutcome,
        winner_outcome_idx: winnerIdx,
        won: settle.won,
        entry_price: pos.entryPrice,
        stake: pos.stake,
        payout: settle.payout,
        realized_return: settle.realizedReturn,
      });
    }
  }

  // 3. Apply cash deltas — one UPDATE per strategy. SQL `+ delta` is
  //    concurrency-safe; reading then writing is not.
  for (const [stratId, delta] of cashDeltaByStrategy.entries()) {
    if (delta === 0) continue;
    await db
      .update(strategies)
      .set({
        currentCash: sql`${strategies.currentCash} + ${delta}`,
        updatedAt: new Date(),
      })
      .where(eq(strategies.id, stratId));

    summary.cash_credited_by_strategy[stratId] =
      (summary.cash_credited_by_strategy[stratId] ?? 0) + delta;
  }
}
