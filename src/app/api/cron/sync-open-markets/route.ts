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

import { db, sqlRaw } from "@/lib/db";
import { markets } from "@/lib/db/schema";
import {
  fetchOpenMarkets,
  parseEndTs,
  GammaUnreachableError,
  type GammaMarket,
} from "@/lib/gamma";
import { lookupStaticLabel, classifyMany } from "@/lib/classify";
import { recordCronRun } from "@/lib/cron-tracker";

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
  // Open-list rows after dedup-by-cid. Polymarket Gamma's paginated open-list
  // is not stable across page boundaries (sort instability), so it commonly
  // returns the same condition_id on consecutive pages. We must dedupe before
  // any bulk INSERT...ON CONFLICT or Postgres rejects the whole batch with
  // code 21000 ("ON CONFLICT DO UPDATE command cannot affect row a second
  // time"). gamma_dupes_dropped > 0 confirms Gamma was returning dupes.
  open_markets_unique: number;
  gamma_dupes_dropped: number;
  matched_static_labels: number;
  classified_via_llm: number;
  classified_skipped_budget: number;
  llm_calls_estimated_cost_usd: number;
  upserted: number;
  upserted_with_future_res: number;
  // Stale-mark pass — tradeable_* markets in our DB whose cid wasn't returned
  // by today's open-list pagination. Likely closed/archived on Gamma; we mark
  // them with resolution_timestamp = 0 (sentinel) so strategies skip them.
  stale_marked: number;
  err?: string;
};

async function runOnce(opts: {
  maxMarkets: number;
  llmBudgetUsd: number;
  maxEndDateDays: number | null;
  staleMark: boolean;
}): Promise<SyncResult> {
  const result: SyncResult = {
    ok: true,
    gamma_reachable: true,
    open_markets_seen: 0,
    open_markets_unique: 0,
    gamma_dupes_dropped: 0,
    matched_static_labels: 0,
    classified_via_llm: 0,
    classified_skipped_budget: 0,
    llm_calls_estimated_cost_usd: 0,
    upserted: 0,
    upserted_with_future_res: 0,
    stale_marked: 0,
  };

  // Step 1: pull open markets from Gamma. Default cap is 365 days (was 60 — see
  // diag_resolution_gap.md): nearly all tradeable_geopolitical markets resolve
  // 90+ days out (e.g. batch end-of-quarter triggers like 2026-07-31), and the
  // 60-day cap was silently dropping them, leaving 590 of 830 with NULL
  // resolution_timestamp despite the cron running every 6h.
  let openList: GammaMarket[];
  try {
    openList = await fetchOpenMarkets({
      maxRows: opts.maxMarkets,
      futureOnly: true,
      maxEndDateDays: opts.maxEndDateDays,
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

  // Dedupe openList by condition_id. Gamma's paginated `?closed=false&active=true`
  // is not order-stable: under load (or when markets close mid-pagination) the
  // same condition_id can appear on multiple pages and end up in our list twice.
  // Postgres' INSERT ... ON CONFLICT DO UPDATE rejects same-row dupes within
  // one statement with SQLSTATE 21000 ("cannot affect row a second time"),
  // failing the whole batch — which is exactly the failure we observed across
  // all hourly sync-open-markets runs from 2026-05-02 12:00 onward (10/22
  // failures in 24h). Last-write-wins on cid; we prefer the more-recently-paged
  // entry (slightly more likely to have a fresh endDate).
  const seenCids = new Set<string>();
  const dedupedOpenList: GammaMarket[] = [];
  // Iterate in reverse so the LAST occurrence of a cid wins, then re-reverse.
  for (let i = openList.length - 1; i >= 0; i--) {
    const m = openList[i];
    const cid = m.conditionId.toLowerCase();
    if (seenCids.has(cid)) continue;
    seenCids.add(cid);
    dedupedOpenList.push(m);
  }
  dedupedOpenList.reverse();
  result.gamma_dupes_dropped = openList.length - dedupedOpenList.length;
  result.open_markets_unique = dedupedOpenList.length;
  if (result.gamma_dupes_dropped > 0) {
    console.warn(
      `[sync-open-markets] gamma returned ${openList.length} rows but only ${dedupedOpenList.length} unique cids (dropped ${result.gamma_dupes_dropped} dupes)`,
    );
  }
  openList = dedupedOpenList;

  console.log(`[sync-open-markets] gamma: ${openList.length} open markets`);

  // Step 2a: pre-load existing DB categories so we skip LLM for any cid we
  // already know. This is the critical perf fix — without it, with 20K open
  // markets, even with 80% in static labels we'd still pay LLM cost on ~4K
  // markets, blowing the 5-min Vercel function budget.
  //
  // We do this in JS (no DB roundtrip). It's actually simpler — we just need
  // to know which cids already have a category in the DB. Pull all cids+cats
  // for tradeable + ambiguous + unknown categories (everything we'd skip LLM
  // on). For 5-10K rows this is one cheap SELECT.
  const dbCidSet = new Set<string>();
  if (openList.length > 0) {
    const knownRes = await db
      .select({ cid: markets.conditionId })
      .from(markets)
      .where(sql`category is not null`);
    for (const r of knownRes) dbCidSet.add(r.cid.toLowerCase());
  }

  // Step 2b: split markets into (already-labelled by static index OR DB) vs (needs LLM)
  type Pending = {
    cid: string;
    question: string | null;
    endTs: number | null;
  };
  // Markets with a known category (static or DB) — we still upsert them (so
  // res_ts gets refreshed) but DON'T pay LLM cost. category=null is fine here
  // because the upsert COALESCE preserves the existing DB value.
  const labelled: Array<Pending & { category: string | null }> = [];
  const needsLlm: Pending[] = [];

  for (const m of openList) {
    const endTs = parseEndTs(m.endDate);
    const cid = m.conditionId.toLowerCase();
    const staticCat = lookupStaticLabel(cid);
    if (staticCat) {
      labelled.push({ cid, question: m.question, endTs, category: staticCat });
    } else if (dbCidSet.has(cid)) {
      // Already classified in DB; pass category=null and let COALESCE preserve it.
      labelled.push({ cid, question: m.question, endTs, category: null });
    } else if ((m.question ?? "").trim()) {
      needsLlm.push({ cid, question: m.question, endTs });
    }
    // markets with no question text + no static label + no DB row are dropped
  }
  result.matched_static_labels = labelled.length;
  console.log(
    `[sync-open-markets] matched ${labelled.length} (static OR pre-classified in DB), ${needsLlm.length} need LLM`,
  );

  // Step 3: LLM-classify the rest if Anthropic key is available. Hard cap of
  // 1500 LLM calls per cron run to leave headroom for the rest of the work
  // (classify ~300ms/call × 1500 / 8 concurrency ≈ 56s, well under maxDuration).
  // Newly-introduced markets between runs are typically << 1500.
  const MAX_LLM_CALLS_PER_RUN = 1500;
  const llmItems = needsLlm.slice(0, MAX_LLM_CALLS_PER_RUN);
  if (needsLlm.length > MAX_LLM_CALLS_PER_RUN) {
    result.classified_skipped_budget = needsLlm.length - MAX_LLM_CALLS_PER_RUN;
    console.warn(
      `[sync-open-markets] capping LLM calls at ${MAX_LLM_CALLS_PER_RUN} (deferring ${result.classified_skipped_budget} to next run)`,
    );
  }
  const llmResults = new Map<string, string | null>();
  if (process.env.ANTHROPIC_API_KEY && llmItems.length > 0) {
    const before = llmItems.length;
    try {
      const m = await classifyMany({
        items: llmItems.map((p) => ({ conditionId: p.cid, question: p.question })),
        concurrency: 8,
        budgetUsd: opts.llmBudgetUsd,
      });
      for (const [k, v] of m.entries()) llmResults.set(k, v);
      result.classified_via_llm = Array.from(m.values()).filter(Boolean).length;
      // Track budget-cap separately from the run-cap above.
      result.classified_skipped_budget += Math.max(0, before - m.size);
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
  // Include all needsLlm cids (even those deferred past MAX_LLM_CALLS_PER_RUN)
  // — we still want to register the cid + endTs in the DB so subsequent runs
  // see them. Deferred ones get category=null and will be re-attempted next
  // run. The COALESCE in the upsert preserves any existing category.
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
  //
  // Belt-and-braces dedupe at the upserts level: openList was already deduped
  // above, so this is a defense-in-depth check. If any future code path adds
  // a cid to upserts twice, we'd hit Postgres 21000 again. Dedupe last-write-
  // wins by cid; track if anything is actually dropped here (it shouldn't be).
  const dedupedUpserts = new Map<string, Upsert>();
  for (const u of upserts) dedupedUpserts.set(u.cid, u);
  if (dedupedUpserts.size !== upserts.length) {
    console.warn(
      `[sync-open-markets] post-bucket dedupe dropped ${upserts.length - dedupedUpserts.size} (this means a NEW dupe path slipped through — investigate)`,
    );
  }
  const finalUpserts = Array.from(dedupedUpserts.values());

  const BATCH = 200;
  for (let i = 0; i < finalUpserts.length; i += BATCH) {
    const slice = finalUpserts.slice(i, i + BATCH);
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
  result.upserted = finalUpserts.length;

  // Step 6: STALE-MARK pass — tradeable_* markets in our DB that did NOT
  // appear in this open-list pagination are almost certainly CLOSED on Gamma
  // (and Gamma's `?conditionIds=` filter is broken so we can't verify
  // individually — see scripts/diag_resolution_gap.md). We sentinel-mark these
  // with resolution_timestamp = 0 so strategies skip them ("future res" filter
  // requires resolution_timestamp > now). Without this, lazy-classified markets
  // that never appear on the open list stay NULL forever, and the
  // edge-eligible cone is permanently empty.
  //
  // Safety: only fire when (a) Gamma returned a healthy open-list count
  // (>= 1000 markets, indicates we paginated successfully) and (b) we didn't
  // hit our maxRows ceiling (which would mean we may have stopped before
  // seeing all open markets).
  if (
    opts.staleMark &&
    result.gamma_reachable &&
    openList.length >= 1000 &&
    openList.length < opts.maxMarkets
  ) {
    const seenCids = new Set(openList.map((m) => m.conditionId.toLowerCase()));
    // Pull tradeable_* DB cids with NULL res_ts. Filter out those we just saw.
    const nullDbRows = await db
      .select({ cid: markets.conditionId })
      .from(markets)
      .where(
        sql`category in ('tradeable_geopolitical','tradeable_political','tradeable_corporate','tradeable_crypto','tradeable_finance','tradeable_business','tradeable_macro','tradeable_judicial','tradeable_other')
            and resolution_timestamp is null`,
      );
    const stale: string[] = [];
    for (const r of nullDbRows) {
      if (!seenCids.has(r.cid.toLowerCase())) stale.push(r.cid);
    }
    if (stale.length > 0) {
      // Bulk update via raw neon (drizzle unrolls JS arrays into tuple params,
      // which breaks `any($1::text[])`). Process in chunks of 5K to stay under
      // any URL/query-size limits — Neon HTTP has a generous limit but no need
      // to be aggressive.
      const CHUNK = 5000;
      for (let i = 0; i < stale.length; i += CHUNK) {
        const slice = stale.slice(i, i + CHUNK);
        await sqlRaw`
          update markets
          set resolution_timestamp = 0,
              updated_at = now()
          where condition_id = any(${slice}::text[])
            and resolution_timestamp is null
        `;
      }
      console.log(
        `[sync-open-markets] stale-marked ${stale.length} cids (NULL → 0)`,
      );
    }
    result.stale_marked = stale.length;
  } else if (opts.staleMark) {
    console.log(
      `[sync-open-markets] skipping stale-mark: openList=${openList.length}, maxMarkets=${opts.maxMarkets}, gamma_reachable=${result.gamma_reachable}`,
    );
  }

  // Step 7: report how many tradeable_* rows now have future resolution.
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
  // Default 25K markets (Gamma had ~23K open at last check — see
  // scripts/diag_test_pagination.ts). Was 5000 before; the cap was hitting
  // first because we filled the limit on close-resolving markets and stopped
  // paging. The 25K default is comfortably above the actual open-list size,
  // so pagination will complete naturally and stale-mark can fire safely.
  const maxMarkets = Math.min(
    Number(url.searchParams.get("max") ?? "25000") || 25000,
    50_000,
  );
  const llmBudgetUsd = Math.min(
    Number(url.searchParams.get("budget") ?? "5") || 5,
    25,
  );
  // Default 365d end-date cap (was 60d). Most tradeable_geopolitical markets
  // resolve 90+ days out (e.g. 2026-07-31 batch trigger), so 60d was silently
  // dropping ~590 of 830 of them. Override with ?days=N or ?days=null to
  // disable entirely.
  const daysParam = url.searchParams.get("days");
  let maxEndDateDays: number | null = 365;
  if (daysParam === "null" || daysParam === "0") {
    maxEndDateDays = null;
  } else if (daysParam) {
    const n = Number(daysParam);
    if (Number.isFinite(n) && n > 0) maxEndDateDays = Math.min(n, 1825);
  }
  // Stale-mark pass on by default. ?stale=0 disables it.
  const staleMark = url.searchParams.get("stale") !== "0";

  const t0 = Date.now();
  try {
    // Wrap in recordCronRun so /admin/crons sees the run history. The wrapper
    // captures start/finish/duration/status/result_json automatically.
    const result = await recordCronRun("sync-open-markets", () =>
      runOnce({
        maxMarkets,
        llmBudgetUsd,
        maxEndDateDays,
        staleMark,
      }),
    );
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
