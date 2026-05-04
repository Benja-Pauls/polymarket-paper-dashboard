// Vercel Cron handler — refresh current_yes_price on markets where any
// strategy has an open position. Runs every 5 minutes on top of the hourly
// sync-open-markets, so the dashboard's MTM unrealized P&L stays close to
// real-time without hammering the API for all 25K open markets.
//
// Why a separate cron instead of just bumping sync-open-markets to 5 min:
//   - sync-open-markets pages 25K+ markets and runs the LLM classifier on
//     newly-seen ones. That's ~30-60s of API + classifier work per run.
//     12× more frequent would push our Anthropic spend from ~$6 to ~$72/mo.
//   - This cron only fetches the small set of markets where we have open
//     positions (typically <300 cids). Sub-second runtime, $0 LLM spend.
//
// Why CLOB and not Gamma: Gamma's `?conditionIds=` filter is broken (returns
// the default page rather than filtering — verified 2026-05-04). CLOB's
// `/markets/<condition_id>` endpoint does exact-match lookups by cid and
// includes live token prices. See src/lib/clob/index.ts for the wire.
//
// Idempotent: only updates the price columns; no state machine, no
// ordering requirement. Safe to fire any number of times.

import { NextResponse } from "next/server";
import { isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { markets, positions as positionsTable } from "@/lib/db/schema";
import { fetchClobMarketsBatch } from "@/lib/clob";
import { recordCronRun } from "@/lib/cron-tracker";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

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

type RefreshResult = {
  ok: boolean;
  open_position_cids: number;
  clob_returned: number;
  prices_updated: number;
  prices_missing: number;
};

async function runOnce(): Promise<RefreshResult> {
  const result: RefreshResult = {
    ok: true,
    open_position_cids: 0,
    clob_returned: 0,
    prices_updated: 0,
    prices_missing: 0,
  };

  // 1. Find every distinct condition_id that has an unsettled position.
  //    We don't filter by strategy.status — even retired strategies' open
  //    positions need accurate MTM until they settle (the historical P&L
  //    chart on a retired strategy still uses MTM).
  const rows = await db
    .selectDistinct({ cid: positionsTable.marketCid })
    .from(positionsTable)
    .where(isNull(positionsTable.settledTs));
  const openCids = rows.map((r) => r.cid);
  result.open_position_cids = openCids.length;
  if (openCids.length === 0) {
    console.log(`[refresh-position-prices] no open positions, nothing to do`);
    return result;
  }
  console.log(
    `[refresh-position-prices] fetching CLOB prices for ${openCids.length} markets with open positions`,
  );

  // 2. Batch-fetch from CLOB at concurrency 8.
  //    ~100 markets × ~50ms each / 8 concurrency ≈ <1s wall-time.
  const byCid = await fetchClobMarketsBatch({
    conditionIds: openCids,
    concurrency: 8,
  });
  result.clob_returned = byCid.size;

  // 3. For each cid we got back, write the new price to markets table.
  //    Single-row UPDATEs (not bulk upsert) because there's only ~hundreds
  //    of these and we don't want to risk SQLSTATE 21000 from a duplicate
  //    cid in the batch (paranoid after 2026-05-02 dedupe fix).
  const now = new Date();
  for (const cid of openCids) {
    const m = byCid.get(cid.toLowerCase());
    if (!m) continue;
    if (m.yesPrice == null) {
      result.prices_missing += 1;
      continue;
    }
    await db
      .update(markets)
      .set({
        currentYesPrice: m.yesPrice,
        priceUpdatedAt: now,
        updatedAt: now,
      })
      .where(sql`${markets.conditionId} = ${cid}`);
    result.prices_updated += 1;
  }
  console.log(
    `[refresh-position-prices] updated ${result.prices_updated} prices, ${result.prices_missing} missing-price, ${openCids.length - result.clob_returned} not-found-on-clob`,
  );
  return result;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const t0 = Date.now();
  try {
    const result = await recordCronRun("refresh-position-prices", () => runOnce());
    const elapsedMs = Date.now() - t0;
    console.log(`[cron] refresh-position-prices done in ${elapsedMs}ms`, result);
    return NextResponse.json({ ...result, elapsed_ms: elapsedMs });
  } catch (e) {
    const elapsedMs = Date.now() - t0;
    console.error(
      `[cron] refresh-position-prices FAILED after ${elapsedMs}ms`,
      e,
    );
    return NextResponse.json(
      { ok: false, error: (e as Error).message, elapsed_ms: elapsedMs },
      { status: 500 },
    );
  }
}

export const POST = GET;
