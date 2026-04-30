// Update bar_status + knownIssues per the comprehensive 10-strategy backtest
// (results/backtest_all_deployed.md, run 2026-04-30 on TEST split, $5K/$10).
//
// Honest rather than aspirational labels — CLAUDE.md previously marked the
// catalyst-gated geo strategies "Bar 2 alpha" but the new comprehensive
// re-test shows they FAIL Bar-1 (concentration > 30%, leave-top-1-out P5
// negative for v4). We keep the strategies running (status='active') so
// live data continues to accumulate, but the badge now reflects truth.
//
// Mapping decisions (with reasons in knownIssues so future reviewers know):
//   v4_broad_clean_v1     — Bar 2 alpha   (only strategy w/ mean ret/$ > +1.0 AND P5 > $15K @ $50)
//   baseline_v1           — Bar 1 floor   (P5 $16,746 @ $50, reproduces CLAUDE.md headline)
//   geo_v2_skipwed        — Bar 1 floor   (P5 $10K @ $50; was Bar 2 in CLAUDE.md but new
//                                          comprehensive shows Bar 1 strict)
//   wave9_mirror_v1       — Bar 1 floor   (P5 $8K @ $50, independent flow vs baseline)
//   geo_v1                — redundant     (rho 0.98 with v2_skipwed, dominated)
//   wave9_mirror_geo_v1   — redundant     (100% bet subset of mirror_v1)
//   all_cat_tight_v1      — redundant     (96% bet subset of all_cat_conservative_v1)
//   all_cat_conservative_v1 — redundant   (dominated by baseline_v1 — same trades, weaker filter)
//   geo_v3_catalyst       — failed        (top-1 conc 32%, 4.4 bpm — fails 4/6 Bar-1 gates)
//   geo_v4_catalyst_3d    — failed        (top-1 conc 37%, 1.6 bpm, leave-top-out P5 = −$173)

import { neon } from "@neondatabase/serverless";

type Spec = {
  id: string;
  bar_status: "Bar 2 alpha" | "Bar 1 floor" | "borderline" | "redundant" | "failed" | "comparison";
  known_issues: string;
};

const UPDATES: Spec[] = [
  {
    id: "v4_broad_clean_v1",
    bar_status: "Bar 2 alpha",
    known_issues:
      "Comprehensive 10-strategy backtest (2026-04-30) confirms Bar 2: only strategy with mean ret/$ +1.065 AND P5 +$18,469 @ $50 stake. Lead recommendation. Question-pattern exclusion filter is doing real work (1.7x mean ret vs baseline at same volume).",
  },
  {
    id: "baseline_v1",
    bar_status: "Bar 1 floor",
    known_issues:
      "Comprehensive backtest (2026-04-30): mean ret/$ +0.637, P5 +$16,746 @ $50, reproduces CLAUDE.md headline. Backbone of the deck. Highest bet rate (43.7 bpm) and best diversification (top-1 3.9%).",
  },
  {
    id: "geo_deep_longshot_v2_skipwed",
    bar_status: "Bar 1 floor",
    known_issues:
      "Comprehensive backtest (2026-04-30): mean ret/$ +1.905 but P5 only +$10,373 @ $50 — Bar 1 strict, not Bar 2 strict (CLAUDE.md previously marked Bar 2 alpha). Dominates geo_v1 (rho 0.98, less Wed-cohort drag). 13 bpm.",
  },
  {
    id: "geo_deep_longshot_v1",
    bar_status: "redundant",
    known_issues:
      "Comprehensive backtest (2026-04-30): rho 0.98 with geo_v2_skipwed (which dominates it). Mean ret/$ +1.461 vs v2's +1.905. Same trades minus Wed-UTC cohort which is loss-skewed. Halt candidate.",
  },
  {
    id: "wave9_mirror_v1",
    bar_status: "Bar 1 floor",
    known_issues:
      "Comprehensive backtest (2026-04-30): mean ret/$ +0.469, P5 +$8,132 @ $50 — Bar 1 floor. Only ~5% bet overlap with baseline_v1 = real flow diversifier. The mirror mechanic 5-10x's bet rate vs longshot-only strategies in live observation. Currently leading the live deck (most bets per hour).",
  },
  {
    id: "wave9_mirror_geo_v1",
    bar_status: "redundant",
    known_issues:
      "Comprehensive backtest (2026-04-30): 100% bet subset of wave9_mirror_v1. mean ret/$ +0.740 (higher per-bet) but P5 only +$3,359 @ $50 due to concentration. mirror_v1 includes all of mirror_geo's signals. Halt candidate.",
  },
  {
    id: "all_cat_tight_v1",
    bar_status: "redundant",
    known_issues:
      "Comprehensive backtest (2026-04-30): 96% bet subset of all_cat_conservative_v1. mean ret/$ +1.450 (higher per-bet) but only 6.4 bpm and P5 +$4,393 @ $50. Halt candidate.",
  },
  {
    id: "all_cat_conservative_v1",
    bar_status: "redundant",
    known_issues:
      "Comprehensive backtest (2026-04-30): dominated by baseline_v1 — same universe, narrower ep band ([0.10,0.20) vs [0.10,0.40)) gives mean ret/$ +0.537 vs baseline's +0.637. P5 +$5,196 vs baseline's +$16,746 @ $50. Halt candidate.",
  },
  {
    id: "geo_deep_longshot_v3_catalyst",
    bar_status: "failed",
    known_issues:
      "Comprehensive backtest (2026-04-30) — FAILS Bar 1 gates 4/6: top-1 concentration 32% (cap 30%); only 4.4 bpm (gate ≥5). Mean ret/$ +3.910 looks alpha-tier per-bet but is a CONCENTRATION TRAP — 8 markets total, 32% from one market. CLAUDE.md headline of 'BAR 2 ALPHA' does not survive cleaner re-test. Halt strongly recommended.",
  },
  {
    id: "geo_deep_longshot_v4_catalyst_3d",
    bar_status: "failed",
    known_issues:
      "Comprehensive backtest (2026-04-30) — FAILS Bar 1 gates 3/6: top-1 conc 37%, 1.6 bpm, leave-top-1-market-out P5 = −$173 (NEGATIVE). Only 5 markets total. Mean ret/$ +4.145 is per-bet alpha but the strategy is a 5-market wager not a deployable approach. CLAUDE.md headline of 'STRONGEST forward result' is single-market noise. Halt strongly recommended.",
  },
];

async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const sql = neon(dbUrl);

  for (const u of UPDATES) {
    const r = await sql`
      UPDATE strategy_methodology
      SET bar_status = ${u.bar_status},
          known_issues = ${u.known_issues},
          updated_at = NOW()
      WHERE strategy_id = ${u.id}
      RETURNING strategy_id, bar_status
    `;
    if (r.length === 0) {
      // Methodology row doesn't exist yet (e.g. wave9_mirror_v1, wave9_mirror_geo_v1
      // were added after the seed). Insert a minimal row.
      await sql`
        INSERT INTO strategy_methodology
          (strategy_id, hypothesis, bar_status, known_issues, filter_descriptions)
        VALUES (
          ${u.id},
          ${'Comprehensive backtest 2026-04-30 (results/backtest_all_deployed.md) is the authoritative reference for this strategy.'},
          ${u.bar_status},
          ${u.known_issues},
          ${'[]'}::jsonb
        )
        ON CONFLICT (strategy_id) DO UPDATE SET
          bar_status = EXCLUDED.bar_status,
          known_issues = EXCLUDED.known_issues,
          updated_at = NOW()
      `;
      console.log(`✓ INSERT ${u.id} → ${u.bar_status}`);
    } else {
      console.log(`✓ UPDATE ${u.id} → ${u.bar_status}`);
    }
  }
  console.log(`\nDone. ${UPDATES.length} strategies updated.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
