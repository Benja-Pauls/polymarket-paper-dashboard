// Final methodology update after the 5-agent review team landed on 2026-05-01.
//
// Key findings that change the deployment-realistic numbers:
//
// 1. BIAS RE-AUDIT: 73% of v10's stacked P5 ($124K → $34K) depends on
//    capturing the FIRST 15 trades of a market. The live cron only sees
//    trades AFTER its cursor; for markets that existed before the cron
//    started, we miss the first-15 alpha. Realistic live floor = $34K.
//
// 2. ACADEMIC PEER REVIEW: ~50% Sharpe deflation needed per Bailey & Lopez
//    de Prado (2014) Deflated Sharpe Ratio with N_trials ≥ 50. Across
//    V5-V10 + parameter sweep + capital scaling + 5-agent review, the
//    actual N_trials tested is likely 500-1000+. With 500 trials,
//    conservative DSR deflation factor ≈ 0.45. Apply this to the
//    bias-re-audit floor of $34K → ~$15K honest P5 estimate.
//
// 3. TRADING EXPERT: 41% of bets are concerning per discretionary review.
//    The 4 surgical filters they recommended (now superseded by the LLM-in-
//    the-loop evaluator R&D wave) would lift selection quality by est ~20%
//    if implemented. Optimistic post-filter: ~$18K honest P5.
//
// 4. INNOVATION BRAINSTORM: 0/3 within-universe ideas beat baseline.
//    Stop assuming hidden alpha multipliers exist within the same
//    Polymarket trade universe.
//
// 5. INDUSTRY REVIEW: top 0.001% historical claim warrants extra
//    skepticism (Polyloly precedent). Phased deployment gates are
//    non-negotiable.
//
// What this update changes:
//  - in_sample_metrics: keep historical headline numbers (they are what
//    they are — bias-adjusted but pre-DSR/pre-first-15-correction)
//  - forward_metrics: update to the honest $15-25K range, NOT the
//    earlier $11K linear-decay extrapolation (which is now superseded
//    by the team-review synthesis)
//  - known_issues: full chain of bias adjustments documented per
//    strategy so reviewers can trace the math
//
// Why we don't INSERT the post-bias number into in_sample: it would
// make the dashboard's historical view inconsistent with the JSON
// results files. Better to keep historical numbers and surface the
// honest forward expectation in the forward_metrics block + the
// methodology card description.

import { neon } from "@neondatabase/serverless";

type Update = {
  id: string;
  forward: {
    mean_ret_per_dollar: number | null;
    total_pnl: number | null;
    p5: number;
    span_label: string;
  };
  known_issues_append: string;
};

const UPDATES: Update[] = [
  {
    id: "v10_direct_top1",
    forward: {
      mean_ret_per_dollar: 0.27,
      total_pnl: 17000,
      p5: 17000,
      span_label: "honest forward (post-team-review bias stack)",
    },
    known_issues_append: ` ┃ Team review 2026-05-01 (5 agents): bias re-audit found 73% of stacked P5 ($124K → $34K) depends on capturing first-15 trades per market — live cron does not currently backfill markets that opened before its cursor. Academic peer review demands ~50% Bailey-LdP DSR deflation (~500+ N_trials across all R&D waves). Trading expert audit found 41% of paper bets concerning. Honest realistic forward 6mo P5 = ~$17K, NOT $124K headline. New R&D wave underway: LLM-augmented bet evaluator, bidirectional-news strategy, native copy-trade overlay. Halt $100K phased deployment plan until those land + 30+ days of post-fix live data accumulates.`,
  },
  {
    id: "v4_broad_clean_v1",
    forward: {
      mean_ret_per_dollar: 0.34,
      total_pnl: 22000,
      p5: 22000,
      span_label: "honest forward (post-team-review bias stack)",
    },
    known_issues_append: ` ┃ Team review 2026-05-01: passed trading-expert audit at 62% bet pass-rate (best on deck). After ~50% DSR deflation + small first-15 capture issue, honest forward 6mo P5 ≈ $22K. Note: v4's BAD_PATTERNS exclusion adds modest in-sample lift but trading-expert recommends LLM-augmented evaluator instead of regex.`,
  },
  {
    id: "baseline_v1",
    forward: {
      mean_ret_per_dollar: 0.20,
      total_pnl: 12000,
      p5: 12000,
      span_label: "honest forward (post-team-review bias stack)",
    },
    known_issues_append: ` ┃ Team review 2026-05-01: simplest baseline; least overfit therefore least DSR-penalized. After bias stack, honest forward 6mo P5 ≈ $12K.`,
  },
  {
    id: "wave9_mirror_v1",
    forward: {
      mean_ret_per_dollar: 0.18,
      total_pnl: 9000,
      p5: 9000,
      span_label: "honest forward (post-team-review bias stack)",
    },
    known_issues_append: ` ┃ Team review 2026-05-01: trading expert flagged mirror as WORST per-bet (30% pass rate) — mirror inverts news-justified BUYs onto the wrong side. Bidirectional-news R&D agent is testing whether news-direction-classified follow/mirror/skip beats always-mirror. Until that lands, treat current wave9_mirror_v1 as suspect; honest forward 6mo P5 ≈ $9K assuming filters land successfully.`,
  },
  {
    id: "geo_deep_longshot_v2_skipwed",
    forward: {
      mean_ret_per_dollar: 0.30,
      total_pnl: 5000,
      p5: 5000,
      span_label: "honest forward (post-team-review bias stack)",
    },
    known_issues_append: ` ┃ Team review 2026-05-01: 2024-2026 mean ret/$ decay flagged by capital-scaling + bias stack; post-correction P5 estimate ~$5K. Recommended satellite-only.`,
  },
];

async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const sql = neon(dbUrl);

  for (const u of UPDATES) {
    // Read current known_issues, append the team-review note.
    const cur = await sql`SELECT known_issues FROM strategy_methodology WHERE strategy_id = ${u.id}`;
    if (cur.length === 0) {
      console.log(`  - ${u.id} (no methodology row, skipping)`);
      continue;
    }
    const newKi = (cur[0].known_issues as string ?? "") + u.known_issues_append;

    await sql`
      UPDATE strategy_methodology
      SET forward_metrics = ${JSON.stringify(u.forward)}::jsonb,
          known_issues = ${newKi},
          updated_at = NOW()
      WHERE strategy_id = ${u.id}
    `;
    console.log(`  ✓ ${u.id} forward P5 → $${u.forward.p5.toLocaleString()}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
