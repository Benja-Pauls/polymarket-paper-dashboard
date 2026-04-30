// Daily cron: prune old skip signals to keep the DB under the Neon 512 MB cap.
//
// Diagnosed 2026-04-30: the signals table grew to 466 MB / 695K rows in
// roughly half a day after the 15-min poll started inserting ~10K skip
// signals per fire (10 strategies × ~1500 trades). Without retention, we
// hit the project size cap and INSERTs start failing.
//
// Retention policy:
//   - Skip signals older than 24 hours: DELETE.
//   - Bet signals: kept forever (they're FK-referenced by positions).
//   - VACUUM after each delete batch to keep the working set warm; explicit
//     VACUUM FULL is reserved for manual operator action (it locks the
//     table — too aggressive for an automatic cron).
//
// The cron runs daily at 06:00 UTC (= 1 AM CST) so it doesn't compete
// with the active poll/sync windows. ~24K rows deleted per run at the
// current rate; <1s with the (decision, raw_ts) partial index.

import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { signals } from "@/lib/db/schema";
import { recordCronRun } from "@/lib/cron-tracker";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

function isAuthorized(req: Request): boolean {
  if (req.headers.get("x-vercel-cron-signature")) return true;
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") || "";
    return auth === `Bearer ${secret}`;
  }
  return process.env.VERCEL_ENV !== "production";
}

const RETENTION_HOURS = 24;
const BATCH_SIZE = 50_000;

async function runOnce(): Promise<{
  ok: boolean;
  before: number;
  deleted: number;
  after: number;
  vacuum: boolean;
}> {
  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_HOURS * 3600;

  const beforeRow = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(signals);
  const before = beforeRow[0]?.n ?? 0;

  let deletedTotal = 0;
  // Loop deletes — keeps each transaction small enough that Neon serverless
  // doesn't trip on transaction-size limits.
  while (true) {
    const r = await db.execute(sql`
      WITH old AS (
        SELECT id FROM signals
        WHERE decision = 'skip' AND raw_ts < ${cutoff}
        LIMIT ${BATCH_SIZE}
      )
      DELETE FROM signals WHERE id IN (SELECT id FROM old)
    `);
    // pg returns rowCount; drizzle's execute exposes it on the result.
    const n =
      typeof (r as unknown as { rowCount?: number }).rowCount === "number"
        ? (r as unknown as { rowCount: number }).rowCount
        : 0;
    deletedTotal += n;
    if (n < BATCH_SIZE) break;
  }

  const afterRow = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(signals);
  const after = afterRow[0]?.n ?? 0;

  let vacuumed = false;
  try {
    // Plain VACUUM (no FULL) — frees space inside the table for reuse but
    // doesn't lock or return memory to the OS. Safe to run hot.
    await db.execute(sql`VACUUM signals`);
    vacuumed = true;
  } catch (e) {
    console.warn(
      `[prune-signals] VACUUM failed (non-fatal): ${(e as Error).message}`,
    );
  }

  return { ok: true, before, deleted: deletedTotal, after, vacuum: vacuumed };
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const t0 = Date.now();
  try {
    const result = await recordCronRun("prune-signals", () => runOnce());
    const elapsedMs = Date.now() - t0;
    console.log(`[cron] prune-signals done in ${elapsedMs}ms`, result);
    return NextResponse.json({ ...result, elapsed_ms: elapsedMs });
  } catch (e) {
    const elapsedMs = Date.now() - t0;
    console.error(`[cron] prune-signals FAILED after ${elapsedMs}ms`, e);
    return NextResponse.json(
      { ok: false, error: (e as Error).message, elapsed_ms: elapsedMs },
      { status: 500 },
    );
  }
}

export const POST = GET;
