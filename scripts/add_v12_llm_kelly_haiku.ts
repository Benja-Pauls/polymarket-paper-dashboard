// v12_llm_kelly_haiku — Phase-1 live deployment of the strong-form LLM
// stake-multiplier strategy. Uses cap-N + ep [0.05, 0.20) base filter, then
// Haiku 4.5 to estimate calibrated probability per candidate bet, then
// Kelly multiplier on stake.
//
// Source: results/llm_evaluator_strong_form.md.
//   Haiku tier: +47.9% Kelly P&L lift over flat on 247-bet sample.
//   Sonnet/Opus: NULL (overconfident outputs over-stake on Kelly).
//
// Phase 1 ships RAW probability (no isotonic calibration in TS yet).
// Phase 2 will add calibration after 100+ live bets accumulate.
// Live cost: ~$0.001-0.003 per evaluation, ~$1-3/month at current rate.

import { neon } from "@neondatabase/serverless";

const HYPOTHESIS = [
  "v12 layers a Haiku 4.5 LLM evaluator on top of v10's deep-longshot filter (cap-N + ep [0.05, 0.20)). For each candidate bet, the LLM estimates the calibrated probability the BET RESOLVES YES. Kelly fraction = (estimated_p - market_price) / (1 - market_price). Kelly fraction is then applied as a stake multiplier capped 0.5×-2.0×; bets with negative edge are SKIPPED.",
  "",
  "Backtested headline (results/llm_evaluator_strong_form.md): +47.9% Kelly P&L lift on 247-bet sample at ECE 0.031 calibration. Bigger models (Sonnet 4.6, Opus 4.7) tested in same harness and PERFORMED WORSE — overconfident outputs cause Kelly to over-stake on the longshot tail. Haiku is empirically the sweet spot, NOT the fallback choice.",
  "",
  "Phase 1 (this deploy): raw probability output. Phase 2 (after 100+ live bets accumulate): port isotonic calibration from Python to TS (~70% of the +47.9% lift came from calibration; raw alone projected to deliver ~33% lift). Phase 1 is intentionally minimal to validate the cron-integration architecture and start accumulating real-world evaluator vs outcome data for Phase 2 calibration.",
  "",
  "What v12 specifically improves over v10: differentiates 10c bets by edge magnitude. v10 stakes flat $10 on every cap-N pass; v12 stakes $5 on a 0.5x-edge bet, $20 on a 2.0x-edge bet, and SKIPS negative-edge bets entirely. Same trade selection, smarter stake sizing.",
].join("\n");

const KNOWN_ISSUES = [
  "Phase 1 deploy (2026-05-01): RAW probability without isotonic calibration.",
  "Expected: ~33% Kelly lift in Phase 1 (vs +47.9% with full calibration in backtest).",
  "Phase 2 calibration training requires 100+ live (raw_p, observed_outcome) pairs. ETA: ~30 days at current bet rate.",
  "Live tripwire: halt if 30-day rolling Kelly P&L drops below flat-staking baseline OR ECE rises above 0.15 (calibration drift).",
  "Live cost: ~$0.001-0.003 per evaluation (Haiku 4.5, ~$1-3/month at current bet rate). Bigger models DO NOT improve outcomes — backtest-confirmed.",
  "Filter visibility: v12-skipped bets carry reason 'llm-evaluator skip: <rationale>' visible in /admin/edge-rate.",
].join(" ");

const FILTER_DESCRIPTIONS = [
  { name: "Cap-N + ep [0.05, 0.20)", description: "v10's base trade selection — deep-longshot range", validation: "results/full_2024_2026_backtest.md" },
  { name: "Haiku 4.5 probability estimator", description: "Tetlockian decomposition prompt; estimates probability the BET RESOLVES YES", validation: "results/llm_evaluator_strong_form.md (+47.9% lift, ECE 0.031)" },
  { name: "Kelly stake multiplier (0.5x-2.0x)", description: "Adjusts stake by edge magnitude / (1 - entry_price) * confidence", validation: "results/llm_evaluator_strong_form.md" },
  { name: "Negative-edge skip", description: "If LLM probability < entry_price + 0.01, skip rather than place flat-stake bet", validation: "results/llm_evaluator_strong_form.md (n_zero_stake = 122/247)" },
  { name: "DO NOT use Sonnet/Opus", description: "Multi-tier comparison showed bigger models perform monotonically worse (Sonnet -26.5% lift, Opus -83.3%). Overconfidence causes Kelly to over-stake.", validation: "results/llm_evaluator_strong_form.md (Section: Surprising finding)" },
];

const PARAMS = {
  ep_lo: 0.05,
  ep_hi: 0.20,
  slippage: 0.02,
  categories: [
    "tradeable_geopolitical",
    "tradeable_political",
    "tradeable_corporate",
    "tradeable_crypto",
  ],
  cap_per_market: 15,
  min_hours_to_res: 72,
  max_hours_to_res: 2160,
  max_market_volume: null,
  llm_evaluator_enabled: true,
};

const DESCRIPTION =
  "v12 (LLM stake-multiplier). Cap-N + ep [0.05, 0.20) base filter + Haiku 4.5 probability estimator + Kelly stake multiplier (0.5x-2.0x). Negative-edge bets SKIPPED. Phase 1 ships raw probability; Phase 2 adds calibration. Backtested +47.9% Kelly P&L lift over flat. Live cost ~$1-3/month.";

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const now = Math.floor(Date.now() / 1000);

  await sql`
    INSERT INTO strategies (id, name, description, params_json, starting_bankroll, current_cash, stake, status, last_poll_ts)
    VALUES (
      'v12_llm_kelly_haiku', 'v12_llm_kelly_haiku', ${DESCRIPTION},
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
  console.log("v12_llm_kelly_haiku active");

  await sql`
    INSERT INTO strategy_methodology (strategy_id, hypothesis, bar_status, known_issues, filter_descriptions, in_sample_metrics, forward_metrics)
    VALUES (
      'v12_llm_kelly_haiku',
      ${HYPOTHESIS},
      'Bar 2 alpha',
      ${KNOWN_ISSUES},
      ${JSON.stringify(FILTER_DESCRIPTIONS)}::jsonb,
      ${JSON.stringify({
        mean_ret_per_dollar: 3.16,
        total_pnl: 7883,
        p5: 3472,
        p_pos: 0.95,
        n_bets: 247,
        n_markets: null,
        span_label: "247-bet sample, calibrated, slip-adjusted",
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
  console.log("methodology row written");

  console.log("\nActive strategies:");
  const r = await sql`SELECT id, status FROM strategies WHERE status='active' ORDER BY id`;
  for (const x of r) console.log(`  ${x.id}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
