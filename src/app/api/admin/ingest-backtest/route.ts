// Admin endpoint: ingest a backtest result JSON into the backtest_runs table.
//
// Two ways to call:
//   1. POST with JSON body — { runLabel, runDescription, results: { strategy_id: { ... } } }
//      This is the canonical path: an R&D agent or operator pastes the
//      contents of a results/<run>.json file. Each top-level strategy_id
//      key becomes one row in backtest_runs.
//   2. GET with ?run_label=<known-name> — preset loaders for the result
//      files we already have on disk in the research repo. Useful for
//      bootstrapping — call once per run, the endpoint reads + parses the
//      file and populates the table.
//
// Security: bearer-token same as cron endpoints (CRON_SECRET in prod). No
// row-level user auth — this is a single-operator dashboard.
//
// Idempotency: each (run_label, strategy_id) pair is unique-ish; calling
// twice updates the existing row (re-ingest from a new JSON revision).

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { db } from "@/lib/db";
import { backtestRuns, type NewBacktestRun } from "@/lib/db/schema";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.VERCEL_ENV !== "production";
  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${secret}`;
}

// Map known result files to a (path-relative-to-research-repo, defaultLabel,
// description) tuple. The path is resolved against RESEARCH_REPO_PATH env
// (falls back to a fixed parent-of-parent location).
const KNOWN_RUNS: Record<
  string,
  {
    relativePath: string;
    description: string;
    parser: "deployed_deck" | "walkforward";
  }
> = {
  backtest_all_deployed: {
    relativePath: "results/backtest_all_deployed.json",
    description:
      "Comprehensive 10-strategy backtest, TEST split (2024-03 → 2026-04, 24.9 mo), $5K bankroll, $50/bet. Bootstrap 1000-iter market-resampling. See results/backtest_all_deployed.md for verdict.",
    parser: "deployed_deck",
  },
  walkforward_deployed_deck: {
    relativePath: "results/walkforward_deployed_deck.json",
    description:
      "Walk-forward monthly (16 sliding 1-mo cohorts Dec 2024 → Mar 2026) plus forward-OOS (Jan-Apr 2026 stratified, 90% non-v7). Combined ~20 monthly verdicts per strategy.",
    parser: "walkforward",
  },
};

const RESEARCH_REPO =
  process.env.RESEARCH_REPO_PATH ||
  "/Users/ben_paulson/Documents/Personal/polymarket-insider-detection";

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Parser for the deployed-deck comprehensive backtest. Schema is roughly:
 *   { config: { bankroll, stake, span_months, ... },
 *     strategies: { <strategy_id>: { n_bets, n_markets, mean_ret_per_dollar,
 *       total_pnl, p5, p50, p95, p_pos, top1_conc, bets_per_month, ... } } }
 */
function parseDeployedDeck(json: Record<string, unknown>): {
  byStrategy: Record<string, NewBacktestRun>;
  meta: { bankroll: number | null; stake: number | null; spanStart: string | null; spanEnd: string | null };
} {
  const cfg = (json.config as Record<string, unknown>) ?? {};
  const bankroll = num(cfg.bankroll) ?? 5000;
  const stake = num(cfg.stake) ?? 50;
  const spanStart = (cfg.test_span_start as string) ?? null;
  const spanEnd = (cfg.test_span_end as string) ?? null;
  // The actual per-strategy block can live under either `strategies` or `per_strategy` —
  // try both.
  const strats =
    (json.strategies as Record<string, unknown>) ??
    (json.per_strategy as Record<string, unknown>) ??
    {};
  const out: Record<string, NewBacktestRun> = {};
  for (const [sid, raw] of Object.entries(strats)) {
    const r = (raw as Record<string, unknown>) ?? {};
    out[sid] = {
      runLabel: "", // filled by caller
      strategyId: sid,
      dataSpanStart: spanStart,
      dataSpanEnd: spanEnd,
      nBets: (num(r.n_bets) as number | null) ?? null,
      nMarkets: (num(r.n_markets) as number | null) ?? null,
      bankroll,
      stake,
      meanRetPerDollar: num(r.mean_ret_per_dollar),
      totalPnl: num(r.total_pnl) ?? num((r as { total_p_l?: number }).total_p_l),
      p5: num(r.p5) ?? num((r as { p_5?: number }).p_5),
      p50: num(r.p50) ?? num((r as { p_50?: number }).p_50),
      p95: num(r.p95) ?? num((r as { p_95?: number }).p_95),
      pPos: num(r.p_pos),
      top1Conc: num(r.top1_conc) ?? num(r.top1_concentration),
      betsPerMonth: num(r.bets_per_month) ?? num(r.bpm),
      resultJson: r as Record<string, unknown>,
      runStartedAt: cfg.run_at ? new Date(String(cfg.run_at)) : new Date(),
    };
  }
  return { byStrategy: out, meta: { bankroll, stake, spanStart, spanEnd } };
}

/**
 * Parser for the walk-forward deck. Top-level schema usually looks like:
 *   { config, summary: { <strategy_id>: { %pos, worst_month, oos_total, ... } } }
 * We surface the OOS/aggregate metrics into the typed columns and stash
 * the full per-month breakdown under result_json.
 */
function parseWalkforward(json: Record<string, unknown>): {
  byStrategy: Record<string, NewBacktestRun>;
  meta: { bankroll: number | null; stake: number | null; spanStart: string | null; spanEnd: string | null };
} {
  const cfg = (json.config as Record<string, unknown>) ?? {};
  const bankroll = num(cfg.bankroll) ?? 5000;
  const stake = num(cfg.stake) ?? 50;
  const summary =
    (json.summary as Record<string, unknown>) ??
    (json.per_strategy as Record<string, unknown>) ??
    (json.strategies as Record<string, unknown>) ??
    {};
  const out: Record<string, NewBacktestRun> = {};
  for (const [sid, raw] of Object.entries(summary)) {
    const r = (raw as Record<string, unknown>) ?? {};
    // Look for both walk-forward + forward-OOS aggregates.
    const oos = ((r.forward_oos as Record<string, unknown>) ?? {}) as Record<string, unknown>;
    out[sid] = {
      runLabel: "",
      strategyId: sid,
      dataSpanStart: (cfg.walkforward_span_start as string) ?? null,
      dataSpanEnd: (cfg.forward_oos_span_end as string) ?? null,
      nBets: num(oos.n_bets) ?? num(r.total_bets),
      nMarkets: num(oos.n_markets) ?? num(r.total_markets),
      bankroll,
      stake,
      meanRetPerDollar: num(oos.mean_ret_per_dollar) ?? num(r.aggregate_mean_ret),
      totalPnl: num(oos.total) ?? num(r.aggregate_total_pnl),
      p5: num(oos.p5) ?? num(r.aggregate_p5),
      p50: num(oos.p50) ?? num(r.aggregate_p50),
      p95: num(oos.p95) ?? num(r.aggregate_p95),
      pPos: num(r.pct_positive_months),
      top1Conc: num(oos.top1_conc),
      betsPerMonth: num(r.bets_per_month),
      resultJson: r as Record<string, unknown>,
      runStartedAt: cfg.run_at ? new Date(String(cfg.run_at)) : new Date(),
    };
  }
  return { byStrategy: out, meta: { bankroll, stake, spanStart: out[Object.keys(out)[0]]?.dataSpanStart ?? null, spanEnd: out[Object.keys(out)[0]]?.dataSpanEnd ?? null } };
}

async function upsertRun(
  runLabel: string,
  runDescription: string | null,
  byStrategy: Record<string, NewBacktestRun>,
): Promise<{ inserted: number; updated: number }> {
  let inserted = 0;
  let updated = 0;
  for (const [sid, row] of Object.entries(byStrategy)) {
    const existing = await db
      .select({ id: backtestRuns.id })
      .from(backtestRuns)
      .where(
        and(eq(backtestRuns.runLabel, runLabel), eq(backtestRuns.strategyId, sid)),
      )
      .limit(1);
    const payload: NewBacktestRun = {
      ...row,
      runLabel,
      runDescription,
    };
    if (existing.length > 0) {
      await db
        .update(backtestRuns)
        .set({ ...payload, ingestedAt: new Date() })
        .where(eq(backtestRuns.id, existing[0].id));
      updated += 1;
    } else {
      await db.insert(backtestRuns).values(payload);
      inserted += 1;
    }
  }
  return { inserted, updated };
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const runLabel = url.searchParams.get("run_label");
  if (!runLabel) {
    return NextResponse.json(
      { ok: false, error: "missing ?run_label= (one of: " + Object.keys(KNOWN_RUNS).join(", ") + ")" },
      { status: 400 },
    );
  }
  const known = KNOWN_RUNS[runLabel];
  if (!known) {
    return NextResponse.json(
      { ok: false, error: `unknown run_label '${runLabel}'; available: ${Object.keys(KNOWN_RUNS).join(", ")}` },
      { status: 400 },
    );
  }
  let raw: string;
  try {
    raw = readFileSync(join(RESEARCH_REPO, known.relativePath), "utf8");
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `failed to read ${known.relativePath}: ${(e as Error).message}` },
      { status: 500 },
    );
  }
  const json = JSON.parse(raw) as Record<string, unknown>;
  const { byStrategy } =
    known.parser === "walkforward" ? parseWalkforward(json) : parseDeployedDeck(json);
  const { inserted, updated } = await upsertRun(runLabel, known.description, byStrategy);
  return NextResponse.json({
    ok: true,
    run_label: runLabel,
    description: known.description,
    n_strategies: Object.keys(byStrategy).length,
    inserted,
    updated,
  });
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json()) as {
    runLabel?: string;
    runDescription?: string;
    parser?: "deployed_deck" | "walkforward";
    json: Record<string, unknown>;
  };
  if (!body.runLabel || !body.json) {
    return NextResponse.json(
      { ok: false, error: "missing runLabel or json in body" },
      { status: 400 },
    );
  }
  const parser = body.parser === "walkforward" ? parseWalkforward : parseDeployedDeck;
  const { byStrategy } = parser(body.json);
  const { inserted, updated } = await upsertRun(
    body.runLabel,
    body.runDescription ?? null,
    byStrategy,
  );
  return NextResponse.json({
    ok: true,
    run_label: body.runLabel,
    n_strategies: Object.keys(byStrategy).length,
    inserted,
    updated,
  });
}
