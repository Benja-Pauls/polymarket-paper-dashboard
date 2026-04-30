// Update strategy_methodology with bias-adjusted post-audit numbers.
//
// Headlines previously cited 21mo TEST-split numbers (e.g. baseline P5 $16,746
// at $50/bet) which the audit (results/audit_inflation_bias.md) showed were
// inflated by:
//   - Cash-constraint not enforced (up to 447 simultaneous opens vs $5K/100 cap)
//   - 2% slippage assumption (real ~5%)
//   - 21% survivor-bias gap on the catalog (TBD follow-up)
//
// New "in-sample" block shows stacked-adjusted historical (cap=100 + 5% extra
// slippage) over 37.4 months on $5K/$50.
// New "forward" block shows the 6-month linear-extrapolated projection from
// 2024→2025→2026 mean-ret/$ decay trajectory.
//
// `knownIssues` carries the full audit summary so reviewers see the basis.

import { neon } from "@neondatabase/serverless";

type Spec = {
  id: string;
  bar_status: string;
  in_sample: {
    mean_ret_per_dollar: number;
    total_pnl: number;
    p5: number;
    p_pos: number;
    n_bets: number;
    n_markets: number;
    span_label: string;
  };
  forward: {
    mean_ret_per_dollar: number;
    total_pnl: number;
    p5: number;
    span_label: string;
  };
  per_year: Record<string, { mean_ret_per_dollar: number; total_pnl: number }>;
  known_issues: string;
};

const UPDATES: Spec[] = [
  {
    id: "baseline_v1",
    bar_status: "Bar 1 floor",
    in_sample: {
      mean_ret_per_dollar: 0.448,
      total_pnl: 178642,
      p5: 78104,
      p_pos: 1.0,
      n_bets: 7972,
      n_markets: 893,
      span_label: "37mo expanded · cap-100 + 5% slip",
    },
    forward: {
      mean_ret_per_dollar: 0.34,
      total_pnl: 5800,
      p5: 5800,
      span_label: "next 6mo · linear decay extrapolation",
    },
    per_year: {
      "2024": { mean_ret_per_dollar: 0.77, total_pnl: 0 },
      "2025": { mean_ret_per_dollar: 0.44, total_pnl: 0 },
      "2026": { mean_ret_per_dollar: 0.34, total_pnl: 0 },
    },
    known_issues: `Comprehensive audit (2026-04-30, results/audit_inflation_bias.md): unconstrained-bootstrap headline P5 +$132,298 reduces to **P5 +$78,104 (-41%)** under realistic capital constraints (cap=100 simultaneous open positions on $5K bankroll) + 5% extra slippage. Most cash-constraint-fragile of the four surviving strategies — peak 447 simultaneous opens in unconstrained backtest. Year-on-year decay trajectory: +0.77 (2024) → +0.44 (2025) → +0.34 (2026); linear extrapolation forward 6 months projects ~+$5.8K, not the 37mo headline. Bootstrap implementation correct (no bug). Filter overfitting: none — strategy uses no per-pattern filters.`,
  },
  {
    id: "v4_broad_clean_v1",
    bar_status: "Bar 2 alpha",
    in_sample: {
      mean_ret_per_dollar: 0.848,
      total_pnl: 0,
      p5: 102429,
      p_pos: 1.0,
      n_bets: 0,
      n_markets: 0,
      span_label: "37mo expanded · cap-100 + 5% slip",
    },
    forward: {
      mean_ret_per_dollar: 0.5,
      total_pnl: 11200,
      p5: 11200,
      span_label: "next 6mo · linear decay extrapolation",
    },
    per_year: {
      "2024": { mean_ret_per_dollar: 0.96, total_pnl: 0 },
      "2025": { mean_ret_per_dollar: 1.30, total_pnl: 0 },
      "2026": { mean_ret_per_dollar: 0.76, total_pnl: 0 },
    },
    known_issues: `Comprehensive audit (2026-04-30, results/audit_inflation_bias.md): unconstrained-bootstrap headline P5 +$132,356 reduces to **P5 +$102,429 (-23%)** under cap=100 + 5% slip. Forward 6mo projection +$11.2K. Strongest single deployment candidate by stacked-adjusted P5. Best top-1 concentration on the deck. Filter overfitting risk: question-pattern exclusion filter adds +0.114 mean_ret and +$5,667 P5 vs no-filter — small but real in-sample bias since patterns were chosen by inspecting v7. Real-world edge likely +0.7-0.8 mean_ret rather than the +0.85 stacked headline.`,
  },
  {
    id: "geo_deep_longshot_v2_skipwed",
    bar_status: "Bar 1 floor",
    in_sample: {
      mean_ret_per_dollar: 1.297,
      total_pnl: 0,
      p5: 88146,
      p_pos: 1.0,
      n_bets: 0,
      n_markets: 0,
      span_label: "37mo expanded · cap-100 + 5% slip",
    },
    forward: {
      mean_ret_per_dollar: -0.1,
      total_pnl: -2500,
      p5: -2500,
      span_label: "next 6mo · linear decay extrapolation (NEGATIVE)",
    },
    per_year: {
      "2024": { mean_ret_per_dollar: 2.98, total_pnl: 0 },
      "2025": { mean_ret_per_dollar: 1.85, total_pnl: 0 },
      "2026": { mean_ret_per_dollar: 1.08, total_pnl: 0 },
    },
    known_issues: `Comprehensive audit (2026-04-30, results/audit_inflation_bias.md): unconstrained-bootstrap headline P5 +$96,493 reduces to **P5 +$88,146 (-9%)** — the MOST robust to capacity constraints of the four (low simultaneous-open density due to geo-only universe). HOWEVER: decaying fastest forward — +2.98 (2024) → +1.85 (2025) → +1.08 (2026), linear extrapolation projects **NEGATIVE** next 6 months (~-$2.5K). The Wed-skip filter was partially in-sample (drops to ~+1.0 mean_ret without it). Use as satellite sleeve only ($0.5-1K) given decay risk.`,
  },
  {
    id: "wave9_mirror_v1",
    bar_status: "Bar 1 floor",
    in_sample: {
      mean_ret_per_dollar: 0.439,
      total_pnl: 0,
      p5: 63274,
      p_pos: 1.0,
      n_bets: 0,
      n_markets: 0,
      span_label: "37mo expanded · cap-100 + 5% slip",
    },
    forward: {
      mean_ret_per_dollar: 0.4,
      total_pnl: 10800,
      p5: 10800,
      span_label: "next 6mo · linear decay extrapolation",
    },
    per_year: {},
    known_issues: `Comprehensive audit (2026-04-30, results/audit_inflation_bias.md): unconstrained-bootstrap headline P5 +$85,022 reduces to **P5 +$63,274 (-26%)** under cap=100 + 5% slip. Most regime-portable of the four — Δ -0.03 from v7 TEST to expanded universe means the mirror mechanic captures generic favorite-longshot bias not bound to v7's market curation. Threshold sensitivity (mirror_min ∈ {0.55, 0.60, 0.65, 0.70}) is robust. Forward 6mo projection +$10.8K. Independent flow vs baseline (~5% bet overlap) — real diversifier when paired.`,
  },
];

async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const sql = neon(dbUrl);

  for (const u of UPDATES) {
    const r = await sql`
      UPDATE strategy_methodology
      SET in_sample_metrics = ${JSON.stringify(u.in_sample)}::jsonb,
          forward_metrics = ${JSON.stringify(u.forward)}::jsonb,
          per_year_metrics = ${JSON.stringify(u.per_year)}::jsonb,
          bar_status = ${u.bar_status},
          known_issues = ${u.known_issues},
          updated_at = NOW()
      WHERE strategy_id = ${u.id}
      RETURNING strategy_id
    `;
    if (r.length === 0) {
      console.log(`⚠ ${u.id} — methodology row missing; insert manually if needed`);
    } else {
      console.log(`✓ ${u.id} — bias-adjusted metrics updated`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
