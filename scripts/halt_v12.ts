// Halt v12_llm_kelly_haiku after forward-OOS validation found it OVERFIT.
// In-sample +47.9% Kelly P&L lift collapsed to -111.4% on a 60-day held-out
// slice (results/v12_forward_oos_validation.md). The isotonic calibration
// overfit; same raw_p ranges had 48.6% win-rate in-sample but 6.5% OOS.
// Kelly trusted the broken calibration and aggressively staked OOS bets
// that turned into systematic losers.
//
// Set status to 'retired' so the cron stops calling Haiku for v12 candidates
// (saves Anthropic spend; live LLM evaluator integration code stays in place
// for any future re-deploy after proper recalibration).

import { neon } from "@neondatabase/serverless";

const HALT_REASON =
  "Forward-OOS validation 2026-05-01 (results/v12_forward_oos_validation.md): in-sample +47.9% Kelly lift collapsed to -111.4% on held-out 60-day slice. ECE drifted 0.031 → 0.128 (above 0.10 gate). Calibration overfit; halt before real-money exposure. The strong-form LLM stake-multiplier hypothesis at the Haiku tier is FALSIFIED. Underlying cap-N + ep filter still works at flat-staking; deployment reverts to baseline_v1 + v4 + wave9 deck.";

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  // Set v12 to retired
  const r = await sql`
    UPDATE strategies
    SET status = 'retired', halt_reason = ${HALT_REASON}, updated_at = NOW()
    WHERE id = 'v12_llm_kelly_haiku'
    RETURNING id, status
  `;
  console.log(`v12 ${r[0]?.status ?? "not found"}`);

  // Update methodology row
  const KNOWN_ISSUES_NEW =
    "HALTED 2026-05-01 after forward-OOS verdict OVERFIT. In-sample 247-bet result was 5-fold CV; the held-out 60-day slice (200 bets) showed Kelly P&L lift collapsing to -111.4%. Calibration overfit: isotonic mapping put raw_p [0.50, 0.90] at cal_p ~ 0.42, matching in-sample 48.6% win rate; OOS same range had 6.5% win rate. Kelly aggressively staked OOS bets that turned into systematic losers. Underlying cap-N + ep filter still works (flat baseline on same OOS still produces geo +$4,088 mean ret/$ +0.394). Process lesson: forward-OOS hold-out is a gate, not a sanity check after the fact. v12 stays as 'retired' with halt_reason recorded. Re-deploy possible AFTER per-category calibration + larger held-out validation. Open follow-ups: (1) SKIP-only LLM mode (no Kelly stake-multiplier) — untested; (2) per-category calibration; (3) train calibration on 1000+ resolved markets, not 247.";

  const FORWARD_NEW = {
    mean_ret_per_dollar: -0.33,
    total_pnl: null,
    p5: null,
    span_label: "FAILED forward-OOS (60d held-out)",
  };

  await sql`
    UPDATE strategy_methodology
    SET bar_status = 'failed',
        known_issues = ${KNOWN_ISSUES_NEW},
        forward_metrics = ${JSON.stringify(FORWARD_NEW)}::jsonb,
        updated_at = NOW()
    WHERE strategy_id = 'v12_llm_kelly_haiku'
  `;
  console.log("methodology row updated to failed");

  // Check whether v12 actually placed any positions in the brief live window
  const pos = await sql`
    SELECT COUNT(*)::int as n,
      COALESCE(SUM(stake), 0)::float as total_stake
    FROM positions WHERE strategy_id = 'v12_llm_kelly_haiku'
  `;
  console.log(`v12 placed ${pos[0].n} positions, total stake $${pos[0].total_stake} (these stay in DB until they resolve naturally)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
