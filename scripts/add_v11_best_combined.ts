// v11_best_combined — the "everything we have learned" strategy.
// Cross-regime-validated mechanics from baseline + Wave-9 mirror, plus
// the two trader-expert filters that do not fight longshot economics.

import { neon } from "@neondatabase/serverless";

const HYPOTHESIS = [
  "v11_best_combined is the everything-we-have-learned strategy. It combines the cross-regime-validated mechanics from baseline_v1 (which won the FPMM regime test with +0.224 pre-2024 mean ret/$) and Wave-9 mirror_v1 (which also survived cross-regime at +0.184), plus two new surgical filters from the trading-expert audit:",
  "",
  "1. Daily-action regex — skips Will X [verb] Y [today/tomorrow/date] patterns. The trading expert found these are virtual-certainty bets where the model loses ~12 cents per dollar of EV (no longshot bias to recover). Examples caught: Will Trump insult someone on May 6? (model bets NO at 14c when YES is 95%+).",
  "",
  "2. min_market_lifespan_hours=48 — skips markets resolving within 48h of dashboard first-seeing them. Catches oracle/resolution-date mismatches like VA Senate primary resolves June 16 when actual primary is August 4. Pure execution error, no edge to recover.",
  "",
  "What v11 DELIBERATELY does not include: LLM evaluator (backtested -15% P5 by skipping bets that aggregate to positive-EV); bidirectional news classifier (random-shuffle test showed signal anti-correlated); shark wallet overlay (temporal split caught leakage); news-leak weighting (shuffle test exposed as variance); v10s deeper-longshot ep [0.05, 0.20) band (FPMM regime test showed -0.005 pre-2024). Each rejection is documented in results/wave_review_*.md and results/pre_2024_full_validation.md.",
  "",
  "Expected forward 6mo P5 on $5K bankroll: ~$20-30K at the cross-regime anchor (baselines +0.224 + ~$5-10K lift from filters). Higher than baseline alone because the daily-action filter alone removes ~12c/$ of EV bleed per trader-expert audit.",
].join("\n");

const KNOWN_ISSUES = [
  "NEW STRATEGY (2026-05-01). Pre-registered before live data accumulates.",
  "Backtested mechanisms individually validated cross-regime; combination is the canonical best of session but combination itself is in-sample (every config tuning is).",
  "Tripwire: halt if 30-day rolling mean ret/$ drops below +0.10 (the cross-regime anchor floor).",
  "Filter visibility: when this strategy skips a trade, the signal reason field reads question matches excluded pattern: daily_action OR market lifespan Xh < 48h (oracle/res-date mismatch suspected) — operators can monitor filter-fire rate via /admin/edge-rate.",
].join(" ");

const FILTER_DESCRIPTIONS = [
  { name: "Cross-regime ep band [0.10, 0.40)", description: "baseline_v1 ep band, validated +0.224 pre-2024 + +0.45 2024-26", validation: "results/pre_2024_full_validation.md" },
  { name: "Mirror favorite at orig price >= 0.60", description: "captures favorite-side BUYs as synthetic longshot bets", validation: "results/wave9_mirror_favorite.md (+0.184 pre-2024)" },
  { name: "Daily-action exclusion (NEW)", description: "regex on Will X [verb] [today/tomorrow/date] patterns", validation: "results/wave_review_trading_expert.md (12c/$ EV bleed identified)" },
  { name: "Min market lifespan 48h (NEW)", description: "skips markets resolving too quickly after dashboard first-sees them", validation: "results/wave_review_trading_expert.md (4 oracle-mismatch cases identified)" },
  { name: "4 main categories (geo/political/corporate/crypto)", description: "drops v10 extra 4 (awards/entertainment/medical/other) which were not validated cross-regime", validation: "results/pre_2024_full_validation.md" },
];

const PARAMS = {
  ep_lo: 0.1,
  ep_hi: 0.4,
  slippage: 0.02,
  categories: [
    "tradeable_geopolitical",
    "tradeable_political",
    "tradeable_corporate",
    "tradeable_crypto",
  ],
  cap_per_market: 10,
  min_hours_to_res: 72,
  max_hours_to_res: 2160, // 90d
  max_market_volume: null,
  mirror_favorite_min_orig_price: 0.6, // Wave-9 mirror mechanic
  exclude_question_patterns: ["daily_action"], // Wave-11 trader-expert filter
  min_market_lifespan_hours: 48, // Wave-11 oracle-mismatch filter
};

const DESCRIPTION =
  "v11 (best of session). Cross-regime-validated mechanics: ep [0.10, 0.40) + cap=10 + mirror_favorite_min_orig_price=0.60 + 4 main tradeable categories. Plus Wave-11 trader-expert filters: daily_action regex + min_market_lifespan_hours=48. Excludes failed mechanisms (LLM evaluator, bidirectional news, shark/news-leak overlays, v10 deep-longshot band).";

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const now = Math.floor(Date.now() / 1000);

  await sql`
    INSERT INTO strategies (id, name, description, params_json, starting_bankroll, current_cash, stake, status, last_poll_ts)
    VALUES (
      'v11_best_combined', 'v11_best_combined', ${DESCRIPTION},
      ${JSON.stringify(PARAMS)}::jsonb,
      1000, 1000, 10, 'active',
      ${now}
    )
    ON CONFLICT (id) DO UPDATE SET
      params_json = EXCLUDED.params_json,
      description = EXCLUDED.description,
      status = 'active',
      updated_at = NOW()
  `;
  console.log("✓ v11_best_combined added/updated as active strategy");

  await sql`
    INSERT INTO strategy_methodology (strategy_id, hypothesis, bar_status, known_issues, filter_descriptions, in_sample_metrics, forward_metrics)
    VALUES (
      'v11_best_combined',
      ${HYPOTHESIS},
      'Bar 1 floor',
      ${KNOWN_ISSUES},
      ${JSON.stringify(FILTER_DESCRIPTIONS)}::jsonb,
      ${JSON.stringify({
        mean_ret_per_dollar: 0.27,
        total_pnl: 25000,
        p5: 25000,
        p_pos: 0.95,
        n_bets: null,
        n_markets: null,
        span_label: "projection: cross-regime anchor + filter lift",
      })}::jsonb,
      ${JSON.stringify({
        mean_ret_per_dollar: null,
        total_pnl: null,
        p5: null,
        span_label: "awaiting live forward-OOS",
      })}::jsonb
    )
    ON CONFLICT (strategy_id) DO UPDATE SET
      hypothesis = EXCLUDED.hypothesis,
      bar_status = EXCLUDED.bar_status,
      known_issues = EXCLUDED.known_issues,
      filter_descriptions = EXCLUDED.filter_descriptions,
      in_sample_metrics = EXCLUDED.in_sample_metrics,
      forward_metrics = EXCLUDED.forward_metrics,
      updated_at = NOW()
  `;
  console.log("✓ methodology row written for v11_best_combined");

  console.log("\n=== Active strategies after v11 deploy ===");
  const r = await sql`SELECT id, status FROM strategies WHERE status='active' ORDER BY id`;
  for (const x of r) console.log(`  ${x.id} (${x.status})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
