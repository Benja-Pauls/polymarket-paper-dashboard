// Final methodology update post-v10 full-universe validation.
//
// v10_direct_top1 confirmed: stacked P5 $124,052 on full 2,440-market
// universe vs v4_broad_clean_v1 $91,218 = +$32,834 (+36%) lift. Top-1
// concentration 1.0% (most diversified on deck), leave-top-1-out P5
// $198K (only -3.3% deflation). DEPLOY recommendation upheld.
//
// This update:
//  1. v10 metrics → full-universe stacked numbers ($124K not $153K).
//  2. v4 known_issues → notes v10 supersedes as new LEAD.
//  3. baseline / mirror / geo → known_issues updated with full-universe
//     numbers (the earlier methodology used prev-expansion estimates).

import { neon } from "@neondatabase/serverless";

type Spec = {
  id: string;
  bar_status?: string;
  in_sample?: Record<string, unknown>;
  forward?: Record<string, unknown>;
  known_issues?: string;
};

const UPDATES: Spec[] = [
  {
    id: "v10_direct_top1",
    bar_status: "Bar 2 alpha",
    in_sample: {
      mean_ret_per_dollar: 0.697,
      total_pnl: 286630, // $5K bankroll, $50/bet, 5707 stacked-filled bets
      p5: 124052,
      p_pos: 1.0,
      n_bets: 5707,
      n_markets: 782,
      span_label: "37mo full universe (2,440 markets) · cap-100 + 5% slip",
    },
    forward: {
      mean_ret_per_dollar: 0.531,
      total_pnl: 83000,
      p5: 83000, // 2026 actual through 4/20 — best forward proxy we have
      span_label: "2026 actuals through 4/20 (best forward proxy)",
    },
    known_issues: `Validated on the FULL 2,440-market universe (results/v10_direct_top1_full_validation.md, 2026-04-30): stacked-deployable P5 = $124K vs v4_broad_clean_v1's $91K (+36%). Top-1 concentration 1.0% — best on the deck. Leave-top-1-out P5 only -3.3% from base. Tripwire: if EITHER May or June 2026 monthly P&L is negative > -$5K AND v4 is positive in the same month, halt v10 and default back to v4. The lift over v4 is driven by dropping v4's BAD_PATTERNS exclusion (v7-TEST overfit per audit) and slightly widening ep_hi from 0.15 to 0.20.`,
  },
  {
    id: "v4_broad_clean_v1",
    known_issues: `Comprehensive audit (2026-04-30) + catalog-gap closure: stacked-deployable P5 dropped from prev-expansion $102K → full-universe $91K (-11%). After parameter-sweep R&D, v10_direct_top1 supersedes v4 as the new LEAD (stacked P5 $124K, +36% over v4). v4 remains active for head-to-head live comparison; halt v10 and revert to v4 if v10 underperforms in May/June 2026 forward-OOS. v4's BAD_PATTERNS exclusion filter was the v7-TEST-overfit component the parameter sweep identified — dropping it (which v10 does) recovers ~$30-50K of stacked-P5 edge.`,
  },
  {
    id: "baseline_v1",
    in_sample: {
      mean_ret_per_dollar: 0.450,
      total_pnl: 0,
      p5: 82911,
      p_pos: 1.0,
      n_bets: 0,
      n_markets: 0,
      span_label: "37mo full universe (2,440 markets) · cap-100 + 5% slip",
    },
    known_issues: `Comprehensive audit + catalog-gap closure (2026-04-30): stacked-deployable P5 on full universe = $82,911. Year-on-year decay narrative was a sampling artifact — 2026 mean ret/$ is comparable to 2024 once survivor bias is closed. Dominated by v10_direct_top1 (+$32K lift on full universe) but kept as backbone/comparison strategy. Most cash-constraint-fragile of the deck (peak 447 simultaneous opens in unconstrained backtest).`,
  },
  {
    id: "wave9_mirror_v1",
    in_sample: {
      mean_ret_per_dollar: 0.439,
      total_pnl: 0,
      p5: 52500,
      p_pos: 1.0,
      n_bets: 0,
      n_markets: 0,
      span_label: "37mo full universe (2,440 markets) · cap-100 + 5% slip",
    },
    known_issues: `Comprehensive audit + catalog-gap closure (2026-04-30): stacked-deployable P5 = $52.5K on full universe. Most regime-portable of the survivors (Δ -0.03 from v7 to expanded means the mirror mechanic captures generic favorite-longshot bias not bound to v7 curation). ~5% bet overlap with v4/v10 — real diversifier when paired. Threshold sensitivity (mirror_min ∈ {0.55, 0.60, 0.65, 0.70}) is robust. Recommended secondary arm alongside v10_direct_top1 for live deployment.`,
  },
  {
    id: "geo_deep_longshot_v2_skipwed",
    in_sample: {
      mean_ret_per_dollar: 0.85,
      total_pnl: 0,
      p5: 26000,
      p_pos: 1.0,
      n_bets: 0,
      n_markets: 0,
      span_label: "37mo full universe (2,440 markets) · cap-100 + 5% slip",
    },
    known_issues: `Comprehensive audit + catalog-gap closure (2026-04-30): stacked-deployable P5 dropped from prev-expansion $88K → full-universe $26K (-70%). The biggest casualty of survivor bias closure. The Wed-skip filter was partially v7-overfit. NO LONGER recommended for primary deployment. Run as small satellite ($0.5K) only if at all. v10_direct_top1 dominates this strategy.`,
  },
];

async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const sql = neon(dbUrl);
  for (const u of UPDATES) {
    const fields: string[] = [];
    const params: Record<string, unknown> = {};
    if (u.bar_status != null) {
      fields.push("bar_status");
      params.bar_status = u.bar_status;
    }
    if (u.in_sample != null) {
      fields.push("in_sample");
      params.in_sample = u.in_sample;
    }
    if (u.forward != null) {
      fields.push("forward");
      params.forward = u.forward;
    }
    if (u.known_issues != null) {
      fields.push("known_issues");
      params.known_issues = u.known_issues;
    }

    if (u.bar_status != null && u.in_sample != null && u.forward != null) {
      await sql`
        UPDATE strategy_methodology
        SET bar_status = ${u.bar_status},
            in_sample_metrics = ${JSON.stringify(u.in_sample)}::jsonb,
            forward_metrics = ${JSON.stringify(u.forward)}::jsonb,
            known_issues = ${u.known_issues ?? null},
            updated_at = NOW()
        WHERE strategy_id = ${u.id}
      `;
    } else if (u.in_sample != null && u.known_issues != null) {
      await sql`
        UPDATE strategy_methodology
        SET in_sample_metrics = ${JSON.stringify(u.in_sample)}::jsonb,
            known_issues = ${u.known_issues},
            updated_at = NOW()
        WHERE strategy_id = ${u.id}
      `;
    } else if (u.known_issues != null) {
      await sql`
        UPDATE strategy_methodology
        SET known_issues = ${u.known_issues}, updated_at = NOW()
        WHERE strategy_id = ${u.id}
      `;
    }
    console.log(`✓ ${u.id} updated [${fields.join(", ")}]`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
