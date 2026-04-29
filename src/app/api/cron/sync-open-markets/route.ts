// Vercel Cron handler — refreshes the universe of OPEN Polymarket markets.
//
// Run periodically (default every 6 hours). For each open market on Gamma:
//   1. Look up its category in the precomputed static label index (free,
//      ~15.5K markets from the research repo).
//   2. If not in the index AND the market has a question text, classify with
//      Claude Haiku 4.5 (~$0.0001/market). Budget capped at $5/run.
//   3. Upsert (condition_id, question_text, category, resolution_timestamp)
//      into the markets table. Don't touch rows the strategies need (e.g.
//      running_volume_usdc, resolved/winner) unless we're filling a gap.
//
// Why this exists: Goldsky's `condition` entity has no concept of `endDate`,
// so on-chain alone we cannot tell whether an unresolved market closes
// tomorrow or in 6 months. Without a future resolution_timestamp every
// strategy trivially skips with "no resolution timestamp known".
//
// Failure modes handled:
//   - Gamma 403 (geo-block):    log & exit 200, fall back to label-only mode
//                                (existing markets still updated via static
//                                 label index where we have condition_ids).
//   - Anthropic missing key:    skip LLM step; log warning.
//   - Massive batch:            classifier capped at budget_usd / call_cost.

import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { markets } from "@/lib/db/schema";
import {
  fetchOpenMarkets,
  parseEndTs,
  GammaUnreachableError,
  type GammaMarket,
} from "@/lib/gamma";
import { lookupStaticLabel, classifyMany } from "@/lib/classify";

export const runtime = "nodejs";
export const maxDuration = 300; // 5 minutes
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

type SyncResult = {
  ok: boolean;
  gamma_reachable: boolean;
  open_markets_seen: number;
  matched_static_labels: number;
  classified_via_llm: number;
  classified_skipped_budget: number;
  llm_calls_estimated_cost_usd: number;
  upserted: number;
  upserted_with_future_res: number;
  err?: string;
};

async function runOnce(opts: {
  maxMarkets: number;
  llmBudgetUsd: number;
}): Promise<SyncResult> {
  const result: SyncResult = {
    ok: true,
    gamma_reachable: true,
    open_markets_seen: 0,
    matched_static_labels: 0,
    classified_via_llm: 0,
    classified_skipped_budget: 0,
    llm_calls_estimated_cost_usd: 0,
    upserted: 0,
    upserted_with_future_res: 0,
  };

  // Step 1: pull open markets from Gamma
  let openList: GammaMarket[];
  try {
    openList = await fetchOpenMarkets({
      maxRows: opts.maxMarkets,
      futureOnly: true,
    });
  } catch (e) {
    if (e instanceof GammaUnreachableError) {
      result.gamma_reachable = false;
      result.err = `gamma unreachable: ${e.message}`;
      console.warn(`[sync-open-markets] ${result.err}`);
      return result;
    }
    throw e;
  }
  result.open_markets_seen = openList.length;
  console.log(`[sync-open-markets] gamma: ${openList.length} open markets`);

  // Step 2: split markets into (already-labelled by static index) vs (needs LLM)
  type Pending = {
    cid: string;
    question: string | null;
    endTs: number | null;
  };
  const labelled: Array<Pending & { category: string }> = [];
  const needsLlm: Pending[] = [];

  for (const m of openList) {
    const endTs = parseEndTs(m.endDate);
    const cid = m.conditionId.toLowerCase();
    const staticCat = lookupStaticLabel(cid);
    if (staticCat) {
      labelled.push({ cid, question: m.question, endTs, category: staticCat });
    } else if ((m.question ?? "").trim()) {
      needsLlm.push({ cid, question: m.question, endTs });
    }
    // markets with no question text + no static label are dropped
  }
  result.matched_static_labels = labelled.length;
  console.log(
    `[sync-open-markets] matched ${labelled.length} via static labels, ${needsLlm.length} need LLM`,
  );

  // Step 3: LLM-classify the rest if Anthropic key is available
  const llmResults = new Map<string, string | null>();
  if (process.env.ANTHROPIC_API_KEY && needsLlm.length > 0) {
    const before = needsLlm.length;
    try {
      const m = await classifyMany({
        items: needsLlm.map((p) => ({ conditionId: p.cid, question: p.question })),
        concurrency: 8,
        budgetUsd: opts.llmBudgetUsd,
      });
      for (const [k, v] of m.entries()) llmResults.set(k, v);
      result.classified_via_llm = Array.from(m.values()).filter(Boolean).length;
      result.classified_skipped_budget = Math.max(0, before - m.size);
      result.llm_calls_estimated_cost_usd = Number(
        (m.size * 0.0002).toFixed(4),
      );
    } catch (e) {
      console.warn(`[sync-open-markets] classify failed:`, (e as Error).message);
    }
  } else if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(`[sync-open-markets] ANTHROPIC_API_KEY not set; skipping LLM classification`);
  }

  // Step 4: build upsert rows. Include LLM-classified ones too.
  type Upsert = {
    cid: string;
    question: string | null;
    endTs: number | null;
    category: string | null;
  };
  const upserts: Upsert[] = [];
  for (const r of labelled) {
    upserts.push({
      cid: r.cid,
      question: r.question,
      endTs: r.endTs,
      category: r.category,
    });
  }
  for (const p of needsLlm) {
    const cat = llmResults.get(p.cid) ?? null;
    upserts.push({
      cid: p.cid,
      question: p.question,
      endTs: p.endTs,
      category: cat,
    });
  }

  // Step 5: bulk upsert. Important: we DON'T overwrite category if it was
  // already set in the DB by an earlier classification (avoid flipping back to
  // null when an LLM call returned null) — the COALESCE in `set` does this.
  const BATCH = 200;
  for (let i = 0; i < upserts.length; i += BATCH) {
    const slice = upserts.slice(i, i + BATCH);
    if (slice.length === 0) continue;
    await db
      .insert(markets)
      .values(
        slice.map((r) => ({
          conditionId: r.cid,
          questionText: r.question,
          category: r.category,
          resolutionTimestamp: r.endTs,
        })),
      )
      .onConflictDoUpdate({
        target: markets.conditionId,
        set: {
          // Always update question text (we have authoritative Gamma question).
          questionText: sql`excluded.question_text`,
          // Only set category if previous was NULL (don't downgrade or
          // overwrite an established category).
          category: sql`coalesce(${markets.category}, excluded.category)`,
          // Only set resolution_timestamp if previous was NULL or in the past.
          // This prevents Gamma drift from corrupting a confirmed settled ts.
          resolutionTimestamp: sql`coalesce(${markets.resolutionTimestamp}, excluded.resolution_timestamp)`,
          updatedAt: new Date(),
        },
      });
  }
  result.upserted = upserts.length;

  // Step 6: report how many tradeable_* rows now have future resolution.
  const nowS = Math.floor(Date.now() / 1000);
  const tradeable = await db
    .select({
      n: sql<number>`count(*)::int`,
    })
    .from(markets)
    .where(
      sql`category in ('tradeable_geopolitical','tradeable_political','tradeable_corporate','tradeable_crypto')
          and resolution_timestamp > ${nowS}`,
    );
  result.upserted_with_future_res = tradeable[0]?.n ?? 0;

  return result;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const maxMarkets = Math.min(
    Number(url.searchParams.get("max") ?? "5000") || 5000,
    20_000,
  );
  const llmBudgetUsd = Math.min(
    Number(url.searchParams.get("budget") ?? "5") || 5,
    25,
  );

  const t0 = Date.now();
  try {
    const result = await runOnce({ maxMarkets, llmBudgetUsd });
    const elapsedMs = Date.now() - t0;
    console.log(`[cron] sync-open-markets done in ${elapsedMs}ms`, result);
    return NextResponse.json({ ...result, elapsed_ms: elapsedMs });
  } catch (e) {
    const elapsedMs = Date.now() - t0;
    console.error(`[cron] sync-open-markets FAILED after ${elapsedMs}ms`, e);
    return NextResponse.json(
      { ok: false, error: (e as Error).message, elapsed_ms: elapsedMs },
      { status: 500 },
    );
  }
}

export const POST = GET;
