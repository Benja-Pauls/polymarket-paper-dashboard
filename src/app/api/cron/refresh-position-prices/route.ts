// Vercel Cron handler — refresh current_yes_price on markets where any
// strategy has an open position, AND settle any positions whose markets
// have resolved on Polymarket.
//
// Two responsibilities (since both use the same CLOB fetch):
//
//   1. PRICE REFRESH: keep markets.current_yes_price up-to-date so the
//      dashboard's MTM unrealized P&L stays accurate (every 5 min).
//
//   2. SETTLEMENT: when CLOB shows a market is closed (resolved) with a
//      winner, mark markets.resolved + winner_outcome_idx, then settle every
//      open position on that market. Cash is credited atomically. This is
//      MONEY-CORRECTNESS code — see src/lib/settlement/index.ts for the
//      shared core that does the math, and the bug history that led to the
//      2026-05-07 fix (settlements weren't firing in production at all).
//
// Why both in one cron: refresh-position-prices already calls CLOB for every
// open-position market every 5 minutes. The CLOB response includes resolution
// data for free (winner field on closed markets). Doing settlement here means
// at most 5-minute settlement latency from the moment Polymarket marks a
// market closed.
//
// Idempotency: every UPDATE filters on `settled_ts IS NULL`. Concurrent
// runs (or the poll cron's own settlement path) cannot double-credit.

import { NextResponse } from "next/server";

import { recordCronRun } from "@/lib/cron-tracker";
import { refreshAndSettle } from "@/lib/settlement";

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

async function runOnce() {
  const summary = await refreshAndSettle();
  console.log(
    `[refresh-position-prices] prices: ${summary.prices_updated} updated, ${summary.prices_missing} missing | resolutions: ${summary.markets_newly_resolved} markets, ${summary.positions_settled} positions, $${summary.cash_credited_total_usd.toFixed(2)} credited`,
  );
  return { ok: true, ...summary };
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const t0 = Date.now();
  try {
    const result = await recordCronRun("refresh-position-prices", () =>
      runOnce(),
    );
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
