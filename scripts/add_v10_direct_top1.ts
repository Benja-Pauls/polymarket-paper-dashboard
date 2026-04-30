// Add v10_direct_top1 as a new live paper-trade strategy.
//
// Source: results/parameter_sweep.md (2026-04-30 R&D). Beats v4_broad_clean_v1
// by +50% on stacked P5 on the prev-expansion universe. Config:
//   ep [0.05, 0.20), cap=15, all 8 tradeable categories, NO question-pattern filter.
//
// Hypothesis: dropping v4's BAD_PATTERNS exclusion (which was v7-TEST overfit
// per the audit) and slightly widening ep_hi recovers $30-50K of stacked-P5
// edge. Worth pre-registering and watching live alongside v4.
//
// Tripwires (per CLAUDE.md "Bar 1 floor" gate):
//   - Pause if cumulative loss > $500 in first 60 days
//   - Pause if 2 consecutive losing weeks
//   - Hard stop if a single month's drawdown exceeds 20% of starting bankroll

import { neon } from "@neondatabase/serverless";

async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const sql = neon(dbUrl);
  const now = Math.floor(Date.now() / 1000);

  const spec = {
    id: "v10_direct_top1",
    name: "v10_direct_top1",
    description:
      "v10 (direct, parameter-sweep winner). Bet ep ∈ [0.05, 0.20), cap=15, all 8 tradeable categories. NO question-pattern filter. Parameter-sweep result: stacked P5 $153K vs v4_broad_clean_v1 $102K (+50%) on prev-expansion universe. The lift comes mostly from dropping v4's BAD_PATTERNS exclusion, which the audit flagged as v7-TEST overfit. Pre-registered for live forward-OOS validation.",
    paramsJson: {
      ep_lo: 0.05,
      ep_hi: 0.20,
      slippage: 0.02,
      categories: [
        "tradeable_geopolitical",
        "tradeable_political",
        "tradeable_corporate",
        "tradeable_crypto",
        "tradeable_awards",
        "tradeable_entertainment_scripted",
        "tradeable_medical",
        "tradeable_other",
      ],
      cap_per_market: 15,
      min_hours_to_res: 72,
      max_hours_to_res: 2160, // 90d
      max_market_volume: null,
      // No exclude_question_patterns by design.
    },
  };

  const r = await sql`
    INSERT INTO strategies (id, name, description, params_json, starting_bankroll, current_cash, stake, status, last_poll_ts)
    VALUES (
      ${spec.id}, ${spec.name}, ${spec.description},
      ${JSON.stringify(spec.paramsJson)}::jsonb,
      1000, 1000, 10, 'active',
      ${now}
    )
    ON CONFLICT (id) DO UPDATE SET
      params_json = EXCLUDED.params_json,
      description = EXCLUDED.description,
      status = 'active',
      updated_at = NOW()
    RETURNING id
  `;
  console.log(`✓ ${r[0].id} added as active strategy.`);

  // Methodology entry — point to parameter_sweep.md for full reasoning.
  await sql`
    INSERT INTO strategy_methodology (strategy_id, hypothesis, bar_status, known_issues, filter_descriptions, in_sample_metrics, forward_metrics)
    VALUES (
      ${spec.id},
      ${'Drop v4_broad_clean_v1\'s BAD_PATTERNS exclusion filter (v7-TEST overfit per audit) and slightly widen ep_hi from 0.15 to 0.20. The parameter sweep (results/parameter_sweep.md, 872-config grid search across direct/geo/mirror families) found this config dominates v4 by +50% on stacked-adjusted P5 ($153K vs $102K) on the prev-expansion universe (1,749 markets). Pre-registered for live forward-OOS validation. If it loses to v4 on the fresh May-June 2026 slice, halt v10 and default back to v4.'},
      ${'Bar 1 floor'},
      ${'Pre-registered 2026-04-30. Awaiting forward-OOS validation. Numbers below are bias-adjusted (cap=100 + 5% slip) on prev-expansion (380 markets); follow-up agent should rerun on the full 2,440-market universe to confirm the +50% lift holds. Pre-2024 mean ret/$ -0.63 (vs v4 -0.93) — slightly more regime-portable than v4 but still loses across the regime break. Tripwires: pause if -$500 in 60 days, pause if 2 consecutive losing weeks, hard stop if single-month drawdown > 20% of starting bankroll.'},
      ${'[]'}::jsonb,
      ${JSON.stringify({
        mean_ret_per_dollar: 1.07,
        total_pnl: 13420,
        p5: 153000,
        p_pos: 1.0,
        n_bets: 1320,
        n_markets: 124,
        span_label: "37mo prev-expansion · cap-100 + 5% slip",
      })}::jsonb,
      ${JSON.stringify({
        mean_ret_per_dollar: null,
        total_pnl: null,
        p5: null,
        span_label: "awaiting live validation",
      })}::jsonb
    )
    ON CONFLICT (strategy_id) DO UPDATE SET
      hypothesis = EXCLUDED.hypothesis,
      bar_status = EXCLUDED.bar_status,
      known_issues = EXCLUDED.known_issues,
      in_sample_metrics = EXCLUDED.in_sample_metrics,
      forward_metrics = EXCLUDED.forward_metrics,
      updated_at = NOW()
  `;
  console.log(`✓ methodology row written.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
