// Rebalance the deck after the pre-2024 FPMM verdict landed (2026-05-01).
//
// FPMM verdict: v10's edge is 2024-2026-regime-specific (-0.005 pre-2024, vs
// +0.480 in 2024-2026). The MECHANIC is real (v4/baseline/wave9 all positive
// pre-2024) but v10's specific deep-longshot optimization is regime-fragile.
//
// Rebalance:
//  - baseline_v1 PROMOTED from "Bar 1 floor" to LEAD STRATEGY:
//    +0.224 pre-2024 + +0.45 2024-2026 = strongest cross-regime survivor
//  - v4_broad_clean_v1 SECOND-ARM: +0.183 pre-2024 + +0.85 2024-2026
//  - wave9_mirror_v1 DIVERSIFIER: +0.184 pre-2024 + +0.44 2024-2026
//  - v10_direct_top1 DEMOTED from "Bar 2 alpha" to "borderline":
//    keep active for live-paper-trade observation; halt-tripwire if
//    30-day rolling mean ret/$ < +0.10 (the 2020Q4 cataclysm signature)
//  - geo_deep_longshot_v2_skipwed remains retired
//
// All forward-projection numbers updated to reflect the more conservative
// cross-regime anchors.

import { neon } from "@neondatabase/serverless";

type Update = {
  id: string;
  bar_status: string;
  forward: { mean_ret_per_dollar: number; total_pnl: number; p5: number; span_label: string };
  known_issues_append: string;
};

const FPMM_FOOTNOTE = ` ┃ FPMM cross-regime verdict (2026-05-01, results/pre_2024_full_validation.md): pulled 332 pre-2024 markets / 104K trades; v10 mean ret/$ -0.005 (NO-GO at scale); v4 +0.183, baseline +0.224, wave9 +0.184 (CONDITIONAL deploy). The MECHANIC works cross-regime; v10's specific deep-longshot optimization is 2024-2026-regime-specific. Lead strategy reassigned baseline_v1.`;

const UPDATES: Update[] = [
  {
    id: "baseline_v1",
    bar_status: "Bar 1 floor",
    forward: {
      mean_ret_per_dollar: 0.224,
      total_pnl: 18000,
      p5: 18000,
      span_label: "cross-regime anchor (pre-2024 result)",
    },
    known_issues_append:
      `${FPMM_FOOTNOTE} ┃ baseline_v1 is now the LEAD DEPLOYABLE strategy. Most regime-portable of the deck (+0.224 pre-2024, +0.45 in 2024-2026 — both substantially positive). Forward 6mo expectation anchored to the pre-2024 mean (the conservative cross-regime number) projects ~$18K stacked-deployable P5 on $5K bankroll. Scaling to $25K → ~$90K projected. Do NOT scale to $100K without 60+ days of post-deployment live data validating the regime hasn't shifted.`,
  },
  {
    id: "v4_broad_clean_v1",
    bar_status: "Bar 1 floor",
    forward: {
      mean_ret_per_dollar: 0.183,
      total_pnl: 14000,
      p5: 14000,
      span_label: "cross-regime anchor (pre-2024 result)",
    },
    known_issues_append:
      `${FPMM_FOOTNOTE} ┃ v4_broad_clean_v1 is the SECOND-ARM deployable. Cross-regime mean ret/$ +0.183 (was +0.848 in 2024-2026, a 78% degradation but still positive). Pair with baseline_v1 for diversified live deck. Forward 6mo P5 ~$14K conservative.`,
  },
  {
    id: "wave9_mirror_v1",
    bar_status: "Bar 1 floor",
    forward: {
      mean_ret_per_dollar: 0.184,
      total_pnl: 12000,
      p5: 12000,
      span_label: "cross-regime anchor (pre-2024 result)",
    },
    known_issues_append:
      `${FPMM_FOOTNOTE} ┃ wave9_mirror_v1 is a DIVERSIFIER alongside baseline + v4. Mirror mechanic survives cross-regime (+0.184 pre-2024, +0.44 in 2024-2026). ~5% bet overlap with baseline = real flow diversification. Forward 6mo P5 ~$12K conservative.`,
  },
  {
    id: "v10_direct_top1",
    bar_status: "borderline",
    forward: {
      mean_ret_per_dollar: -0.005,
      total_pnl: 0,
      p5: -3000,
      span_label: "REGIME-FRAGILE — pre-2024 was -0.005",
    },
    known_issues_append:
      `${FPMM_FOOTNOTE} ┃ DEMOTED FROM LEAD on 2026-05-01 after the FPMM regime test. v10 mean ret/$ collapsed -0.005 in pre-2024 conditions vs +0.480 in 2024-2026. v10's deep-longshot optimization is 2024-2026-election-cycle-specific. Keep ACTIVE for live-paper-trade observation only — halt-tripwire if 30-day rolling mean ret/$ < +0.10 (the 2020Q4 cataclysm signature). Do NOT deploy real money on v10 standalone. The +$124K headline P5 was regime-fragile; the +$1M projection at $100K bankroll was based on a regime that may not persist.`,
  },
  {
    id: "geo_deep_longshot_v2_skipwed",
    bar_status: "redundant",
    forward: {
      mean_ret_per_dollar: 0.0,
      total_pnl: 0,
      p5: 0,
      span_label: "retired — no real-money deployment",
    },
    known_issues_append:
      `${FPMM_FOOTNOTE} ┃ Remains retired. Pre-2024 sample too thin for geo-only universe to validate.`,
  },
];

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  for (const u of UPDATES) {
    const cur = await sql`SELECT known_issues FROM strategy_methodology WHERE strategy_id = ${u.id}`;
    if (cur.length === 0) { console.log(`  - ${u.id} no row, skipping`); continue; }
    const newKi = (cur[0].known_issues as string ?? "") + u.known_issues_append;
    await sql`
      UPDATE strategy_methodology
      SET bar_status = ${u.bar_status},
          forward_metrics = ${JSON.stringify(u.forward)}::jsonb,
          known_issues = ${newKi},
          updated_at = NOW()
      WHERE strategy_id = ${u.id}
    `;
    console.log(`  ✓ ${u.id} → ${u.bar_status}, forward P5 $${u.forward.p5.toLocaleString()}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
