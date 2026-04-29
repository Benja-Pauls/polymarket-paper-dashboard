// Seeds the strategy_methodology table for all 6 deployed strategies.
//
// Source material:
//   - polymarket-insider-detection/RESEARCH_AND_STRATEGY.md (Decision Log)
//   - polymarket-insider-detection/DEPLOYMENT_PLAN_v1.md (strategy spec)
//   - polymarket-insider-detection/CLAUDE.md (live hypothesis list)
//
// Usage: pnpm exec tsx --env-file=.env.local scripts/seed_methodology.ts
// Idempotent — safe to re-run.

import { db } from "../src/lib/db";
import {
  strategyMethodology,
  type FilterDescription,
  type MethodologyMetrics,
  type NewStrategyMethodology,
} from "../src/lib/db/schema";

type Entry = {
  strategyId: string;
  hypothesis: string;
  inSample: MethodologyMetrics;
  forward: MethodologyMetrics;
  perYear: Record<string, MethodologyMetrics>;
  filters: FilterDescription[];
  knownIssues: string;
  barStatus: "Bar 2 alpha" | "Bar 1 floor" | "borderline" | "comparison";
};

const SHARED_FILTERS = {
  ep_15: {
    name: "Entry price ∈ [0.05, 0.15)",
    description:
      "Deeply mispriced longshots — only buy outcomes where the market currently prices them between 5% and 15% probability.",
    validation:
      "Per-cat R&D found this band has the strongest favorite-longshot bias. Mean realised return-per-dollar +1.27 in-sample (geo) vs +0.51 for the broader [0.10, 0.50] band.",
  },
  ep_15_bar1: {
    name: "Entry price ∈ [0.10, 0.15)",
    description:
      "Tightest longshot band: 10–15% implied probability. Highest per-bet edge across categories.",
    validation:
      "All-cat universe in-sample mean ret/$ +0.99 (vs +0.51 baseline); forward +1.12. Validated in both samples.",
  },
  ep_20: {
    name: "Entry price ∈ [0.10, 0.20)",
    description:
      "Slightly wider longshot band — slightly less per-bet edge but more bets and more market diversification.",
    validation:
      "All-cat in-sample +0.76 mean ret/$, total +$80K (the most total $ of any tested band); forward +0.91. Bar-1 floor candidate.",
  },
  ep_40: {
    name: "Entry price ∈ [0.10, 0.40)",
    description:
      "Original 'tighter blanket' band. Captures the favorite-longshot bias generically without isolating the strongest signal.",
    validation:
      "Generic edge: in-sample mean ret/$ +0.48, forward +0.62. Borderline Bar-1 — passes 3/4 strict criteria.",
  },
  hours24: {
    name: "Time-to-resolution ≥ 24h",
    description:
      "Don't bet markets that resolve in under a day — leaves room for surprise catalysts to move pricing.",
    validation:
      "Sub-24h markets are dominated by terminal-decay dynamics; the longshot edge requires resolution uncertainty.",
  },
  hours72: {
    name: "Time-to-resolution ≥ 72h",
    description:
      "Three-day buffer — used for cross-category strategies where average market life is longer.",
    validation:
      "Aligns with the original tighter_blanket validation; passes random-universe ablation.",
  },
  cap5: {
    name: "Cap = 5 bets per market",
    description:
      "At most 5 chronological entries on any single market — caps concentration.",
    validation:
      "Tight-cap variants outperform cap=10 on per-bet ret/$ at the cost of fewer total bets. Trade-off chosen for the alpha-tier strategies.",
  },
  cap10: {
    name: "Cap = 10 bets per market",
    description:
      "At most 10 chronological entries on any single market — caps concentration.",
    validation:
      "Bar-1 conservative band: capacity-friendly without sacrificing diversification.",
  },
  cap20: {
    name: "Cap = 20 bets per market",
    description:
      "Up to 20 chronological entries on a single market — only used on geo deep-longshot where the universe is small.",
    validation:
      "Geo universe is narrow (71 markets in-sample); cap=20 lets the strategy compound when a high-conviction market produces multiple longshot trades.",
  },
  vol100: {
    name: "Market running volume < $100K",
    description:
      "Skip when the on-chain notional we've watched on the market crosses $100K — high-volume markets have more efficient pricing.",
    validation:
      "Random-universe ablation showed the volume cap adds material per-bet edge on top of price + cap; markets above $100K behave closer to fair.",
  },
  geo_only: {
    name: "Category = tradeable_geopolitical only",
    description:
      "Restrict to geopolitical contracts — strongest favorite-longshot bias of the four tradeable categories.",
    validation:
      "Per-cat R&D (Apr 2026) showed isolating geo beats all-cat across both samples: +1.27 mean ret/$ vs +0.99 (all-cat tight) in-sample.",
  },
  all_cats: {
    name: "All tradeable categories (geo / political / corporate / crypto)",
    description:
      "Cross-category — broader universe, more bets, more diversification. Average per-bet edge is lower than geo-only but capacity is higher.",
    validation:
      "All-cat strategies trade per-bet edge for n_bets and market diversification. Bar-1 floor candidates.",
  },
};

const ENTRIES: Entry[] = [
  // ──────────────────────────────────────────────────────────────────────
  // 1. geo_deep_longshot_v1
  // ──────────────────────────────────────────────────────────────────────
  {
    strategyId: "geo_deep_longshot_v1",
    hypothesis: `**Tradeable geopolitical markets have the strongest favorite-longshot bias** when three conditions hold:

1. **Entry price is deeply mispriced** (0.05–0.15) — the longer the longshot, the larger the per-dollar edge when it hits.
2. **Time-to-resolution gives surprise potential** (≥ 24h) — sub-24h markets are dominated by terminal-decay dynamics that erase the longshot edge.
3. **Volume hasn't priced things in** (< $100K cumulative on-chain notional) — high-volume markets are too efficient.

Per-category R&D (Apr 2026) compared all-cat vs geo-only on the same band and showed isolating tradeable_geopolitical beats blended all-cat by ≈ +0.28 mean ret/$ in-sample. Geo's longshot bias is structurally larger because: (a) geopolitical events have heavy-tailed outcome distributions, (b) public attention concentrates on the favorite, and (c) thin liquidity slows arb. This strategy isolates that signal at the strongest band.`,
    inSample: {
      mean_ret_per_dollar: 1.27,
      total_pnl: 170_000,
      p5: 97_000,
      p_pos: 1.0,
      n_bets: 1234,
      n_markets: 71,
      span_label: "21mo (Aug 2024 – Apr 2026)",
    },
    forward: {
      mean_ret_per_dollar: 1.25,
      total_pnl: 82_000,
      p5: 29_000,
      p_pos: 1.0,
      n_bets: 458,
      n_markets: 38,
      span_label: "Forward-OOS (Jan – Apr 2026, ~4mo)",
    },
    perYear: {
      "2024": {
        mean_ret_per_dollar: 1.31,
        total_pnl: 71_000,
        p5: 35_000,
        span_label: "Aug – Dec 2024",
      },
      "2025": {
        mean_ret_per_dollar: 1.22,
        total_pnl: 99_000,
        p5: 48_000,
        span_label: "Full year 2025",
      },
      "2026": {
        mean_ret_per_dollar: 1.25,
        total_pnl: 82_000,
        p5: 29_000,
        span_label: "Jan – Apr 2026 (forward)",
      },
    },
    filters: [
      SHARED_FILTERS.geo_only,
      SHARED_FILTERS.ep_15,
      SHARED_FILTERS.hours24,
      SHARED_FILTERS.vol100,
      SHARED_FILTERS.cap20,
    ],
    knownIssues: `- Universe is narrow (≈ 71 markets across 21 months in-sample). One slow geopolitical month can mean very few bets.
- Top-1 market concentration is moderate (≈ 8–12%) — still well under the 30% bar but worth monitoring.
- Exposed to regime shifts in geopolitical news cycle: a quiet stretch on tariffs / Ukraine / Mideast etc. would shrink the universe further.
- Slippage assumed at 2% — if real fills are worse on thin order books, edge could erode by ≈ 0.05–0.10 per dollar.`,
    barStatus: "Bar 2 alpha",
  },

  // ──────────────────────────────────────────────────────────────────────
  // 2. geo_deep_longshot_v2_skipwed
  // ──────────────────────────────────────────────────────────────────────
  {
    strategyId: "geo_deep_longshot_v2_skipwed",
    hypothesis: `**Wednesday clusters of public catalysts (FOMC, mid-week speeches, scheduled press events) lock in favorites and the deep-longshot edge can't surprise.**

Audit of the v1 trade ledger by day-of-week showed Wednesday UTC was a consistent loser in BOTH samples:
- In-sample mean ret/$ on Wed = **−0.10** (n ≈ 290)
- Forward-OOS mean ret/$ on Wed = **−0.91** (n ≈ 502, much worse)

Removing Wednesday is a five-line filter that lifts mean ret/$ from +1.27 → **+1.45** in-sample and +1.25 → **+1.37** forward, with a small reduction in n_bets. The forward number is the tighter test — and it improved markedly. This is the same v1 strategy with one extra filter; it does not add new universe.`,
    inSample: {
      mean_ret_per_dollar: 1.45,
      total_pnl: 175_000,
      p5: 105_000,
      p_pos: 1.0,
      n_bets: 944,
      n_markets: 70,
      span_label: "21mo (Aug 2024 – Apr 2026)",
    },
    forward: {
      mean_ret_per_dollar: 1.37,
      total_pnl: 85_000,
      p5: 32_000,
      p_pos: 1.0,
      n_bets: 356,
      n_markets: 38,
      span_label: "Forward-OOS (Jan – Apr 2026, ~4mo)",
    },
    perYear: {
      "2024": {
        mean_ret_per_dollar: 1.51,
        total_pnl: 73_000,
        span_label: "Aug – Dec 2024",
      },
      "2025": {
        mean_ret_per_dollar: 1.41,
        total_pnl: 102_000,
        span_label: "Full year 2025",
      },
      "2026": {
        mean_ret_per_dollar: 1.37,
        total_pnl: 85_000,
        span_label: "Jan – Apr 2026 (forward)",
      },
    },
    filters: [
      SHARED_FILTERS.geo_only,
      SHARED_FILTERS.ep_15,
      SHARED_FILTERS.hours24,
      SHARED_FILTERS.vol100,
      SHARED_FILTERS.cap20,
      {
        name: "Skip Wednesday UTC",
        description:
          "Don't enter trades whose timestamp falls on a Wednesday in UTC.",
        validation:
          "Wed mean ret/$ = −0.10 in-sample (n=290), −0.91 forward (n=502). Removing Wed lifts overall mean from +1.27 → +1.45 in-sample, +1.25 → +1.37 forward.",
      },
    ],
    knownIssues: `- Day-of-week filter is data-snooped on the same trade ledger — keep monitoring whether Wednesday underperformance persists in true live data.
- Loses ≈ 23% of v1's bet count by sitting out one day in seven. Capacity-aware sizing should account for this.
- If geopolitical catalyst calendars shift to e.g. Tuesdays, this filter becomes stale and may need revalidation.`,
    barStatus: "Bar 2 alpha",
  },

  // ──────────────────────────────────────────────────────────────────────
  // 3. geo_deep_longshot_v3_catalyst
  // ──────────────────────────────────────────────────────────────────────
  {
    strategyId: "geo_deep_longshot_v3_catalyst",
    hypothesis: `**Betting BEFORE a known public catalyst gives massive lift.** The deep-longshot strategy's edge IS informed surprise — when there's a future scheduled event (FOMC, election, deadline, summit), the longshot has a reason to repri ce.

Methodology:
- Built a market_catalysts table from a curated source list of public events with timestamps tied to specific Polymarket markets.
- Filter: only enter if a catalyst exists for the market AND that catalyst's timestamp is in the FUTURE relative to trade time.

Result: in-sample mean ret/$ = **+3.93** (vs v1 base +1.27 — a +2.66 lift). Forward-OOS mean ret/$ = **+1.78** (vs v1 forward +1.25 — a +0.53 lift, more conservative). Smaller universe (22 markets in-sample vs v1's 71) but materially higher per-bet edge. Top-1 concentration 26.5% (borderline; close to but under the 30% bar).`,
    inSample: {
      mean_ret_per_dollar: 3.93,
      total_pnl: 127_000,
      p5: 71_000,
      p_pos: 0.99,
      top1_pct: 26.5,
      n_bets: 187,
      n_markets: 22,
      span_label: "21mo (Aug 2024 – Apr 2026)",
    },
    forward: {
      mean_ret_per_dollar: 1.78,
      total_pnl: 41_000,
      p5: 14_000,
      p_pos: 0.96,
      n_bets: 76,
      n_markets: 14,
      span_label: "Forward-OOS (Jan – Apr 2026, ~4mo)",
    },
    perYear: {
      "2024": {
        mean_ret_per_dollar: 4.21,
        total_pnl: 56_000,
        span_label: "Aug – Dec 2024",
      },
      "2025": {
        mean_ret_per_dollar: 3.62,
        total_pnl: 71_000,
        span_label: "Full year 2025",
      },
      "2026": {
        mean_ret_per_dollar: 1.78,
        total_pnl: 41_000,
        span_label: "Jan – Apr 2026 (forward)",
      },
    },
    filters: [
      SHARED_FILTERS.geo_only,
      SHARED_FILTERS.ep_15,
      SHARED_FILTERS.hours24,
      SHARED_FILTERS.vol100,
      SHARED_FILTERS.cap20,
      {
        name: "Require future public catalyst",
        description:
          "Only bet markets that have a known scheduled public event (catalyst) tied to the outcome AND where that catalyst is still in the future at trade time.",
        validation:
          "Lifts in-sample mean ret/$ from +1.27 → +3.93 (+2.66) and forward from +1.25 → +1.78 (+0.53). The forward lift is smaller but still well above Bar-2 alpha.",
      },
    ],
    knownIssues: `- **Catalyst data has historical bias** — the curated catalyst list was built retrospectively, so in-sample numbers may overstate edge. Forward number (+1.78) is the trustworthy one.
- **Universe is small (≈ 22 markets in-sample, 14 forward)** — fewer bets means more variance and higher single-market concentration.
- **Top-1 concentration 26.5% is close to the 30% bar** — one bad market could swing the strategy.
- **Catalyst data needs weekly refresh** — events get rescheduled, new ones get added. A stale catalyst table will silently degrade the strategy.
- Forward-OOS lift was smaller than in-sample (+0.53 vs +2.66), which is a yellow flag; monitor live numbers carefully.`,
    barStatus: "Bar 2 alpha",
  },

  // ──────────────────────────────────────────────────────────────────────
  // 3b. geo_deep_longshot_v4_catalyst_3d
  // ──────────────────────────────────────────────────────────────────────
  {
    strategyId: "geo_deep_longshot_v4_catalyst_3d",
    hypothesis: `**Strategy v3 already requires a future catalyst, but catalysts within 0–3 days have effectively arrived: market participants know the event is imminent and price moves to the favored outcome. Adding a 3-day minimum lead time keeps surprise potential intact while still requiring market-relevant news. Plus: heuristic-only catalysts (no real Wikipedia/GDELT source) are unreliable signals — exclude them.**

R&D wave 4 audit on v3's trade ledger split bets by catalyst lead time and showed the per-bet edge is concentrated almost entirely in the ≥ 3-day bucket; catalysts within 0–3 days produce roughly break-even outcomes because the surprise has already been priced in. Layering a "real catalyst source" filter (gdelt OR wikipedia, dropping heuristic-only) tightens the universe further.

Result: STRONGEST forward result yet — in-sample mean ret/$ = **+4.29** (vs v3 +3.93, v1 +1.27); forward-OOS mean ret/$ = **+3.19** (vs v3 +1.78, v1 +1.25). And critically: per-year alpha-tier in EVERY year — 2024 (+6.13), 2025 (+4.22), 2026 (+4.00). v3 (no min-lead, allows heuristic) leaves real edge on the table.`,
    inSample: {
      mean_ret_per_dollar: 4.29,
      total_pnl: 104_000,
      p5: 57_000,
      p_pos: 1.0,
      top1_pct: 5.0,
      n_bets: 484,
      span_label: "21mo (Aug 2024 – Apr 2026)",
    },
    forward: {
      mean_ret_per_dollar: 3.19,
      total_pnl: 44_000,
      p5: 12_700,
      p_pos: 0.995,
      top1_pct: 29.3,
      n_bets: 277,
      span_label: "Forward-OOS (~3.6mo, annualized P5 ≈ $43K)",
    },
    perYear: {
      "2024": {
        mean_ret_per_dollar: 6.13,
        span_label: "Aug – Dec 2024",
      },
      "2025": {
        mean_ret_per_dollar: 4.22,
        span_label: "Full year 2025",
      },
      "2026": {
        mean_ret_per_dollar: 4.00,
        span_label: "Jan – Apr 2026 (forward)",
      },
    },
    filters: [
      SHARED_FILTERS.geo_only,
      SHARED_FILTERS.ep_15,
      SHARED_FILTERS.hours24,
      SHARED_FILTERS.vol100,
      SHARED_FILTERS.cap20,
      {
        name: "Require future public catalyst ≥ 3 days out",
        description:
          "Only bet markets whose known scheduled public event is at least 72 hours in the future at trade time. Catalysts within 0–3 days have effectively arrived.",
        validation:
          "v3 → v4 lift: in-sample mean ret/$ +3.93 → +4.29 (+0.36); forward +1.78 → +3.19 (+1.41). The forward lift is the load-bearing one and it nearly doubles the per-bet edge.",
      },
      {
        name: "Require real catalyst source (gdelt OR wikipedia)",
        description:
          "Reject markets whose catalyst record came only from the heuristic source. Real news-derived catalysts (gdelt or wikipedia) carry materially more signal.",
        validation:
          "Heuristic-only catalysts behave near-random in audits; restricting to gdelt/wikipedia tightens the universe and lifts per-bet edge without hurting bet density meaningfully.",
      },
    ],
    knownIssues: `- Top-1 concentration **29.3% on the forward sample is borderline** (Bar 1 limit is 30%). One bad market could push the strategy over the limit; monitor live concentration carefully.
- **March 2026 still shows weakness (+0.45 mean ret/$)** regardless of catalyst lead time — this is a regime-specific issue and not solvable by tighter catalyst filtering alone.
- **Forward span only 3.6 months** — annualized projections (P5 ≈ $43K/yr on $5K bankroll) extrapolate a short window; treat as suggestive not definitive.
- Catalyst data is curated retrospectively; in-sample numbers may be optimistic. Forward (+3.19) is the trustworthy metric.
- Smaller universe than v3 — fewer bets means more variance.`,
    barStatus: "Bar 2 alpha",
  },

  // ──────────────────────────────────────────────────────────────────────
  // 4. all_cat_tight_v1
  // ──────────────────────────────────────────────────────────────────────
  {
    strategyId: "all_cat_tight_v1",
    hypothesis: `**The tightest entry-price band [0.10, 0.15) on the all-category universe with cap=5 captures the highest per-bet edge per market.**

Reasoning: longshot bias is mechanically extractable across all four tradeable categories — political, corporate, crypto and geopolitical — but the strongest per-dollar edge sits at the lowest priced longshot band. cap=5 keeps single-market concentration low while preserving enough density to compound.

Validated in both samples:
- In-sample mean ret/$ = **+0.99**, P5 = +$27K on $5K bankroll over 21 months.
- Forward-OOS mean ret/$ = **+1.12**, P5 = +$5.8K over ≈ 3.5 months.

This is the all-cat alpha-tier complement to the geo-specific deep longshot — broader capacity, broader market diversity.`,
    inSample: {
      mean_ret_per_dollar: 0.99,
      total_pnl: 60_000,
      p5: 27_000,
      p_pos: 0.97,
      n_bets: 612,
      n_markets: 198,
      span_label: "21mo (Aug 2024 – Apr 2026)",
    },
    forward: {
      mean_ret_per_dollar: 1.12,
      total_pnl: 14_500,
      p5: 5_800,
      p_pos: 0.94,
      n_bets: 162,
      n_markets: 84,
      span_label: "Forward-OOS (Jan – Apr 2026, ~3.5mo)",
    },
    perYear: {
      "2024": {
        mean_ret_per_dollar: 1.04,
        total_pnl: 24_000,
        span_label: "Aug – Dec 2024",
      },
      "2025": {
        mean_ret_per_dollar: 0.96,
        total_pnl: 36_000,
        span_label: "Full year 2025",
      },
      "2026": {
        mean_ret_per_dollar: 1.12,
        total_pnl: 14_500,
        span_label: "Jan – Apr 2026 (forward)",
      },
    },
    filters: [
      SHARED_FILTERS.all_cats,
      SHARED_FILTERS.ep_15_bar1,
      SHARED_FILTERS.hours72,
      SHARED_FILTERS.vol100,
      SHARED_FILTERS.cap5,
    ],
    knownIssues: `- Forward window is short (≈ 3.5 months); P5 on a $5K bankroll is $5.8K which is at the edge of the Bar-2 P5 > $15K criterion when annualized.
- Cross-category exposure means one bad category (e.g. crypto longshots in a quiet month) can drag the average — monitor per-category attribution.
- cap=5 means low capacity per market; if many markets fire simultaneously, the strategy may be cash-constrained.`,
    barStatus: "Bar 2 alpha",
  },

  // ──────────────────────────────────────────────────────────────────────
  // 5. all_cat_conservative_v1
  // ──────────────────────────────────────────────────────────────────────
  {
    strategyId: "all_cat_conservative_v1",
    hypothesis: `**The wider band [0.10, 0.20) trades a smaller per-bet edge for many more bets and more market diversification.**

This is the **risk-averse deployment candidate** — the band where favorite-longshot bias is still clearly extractable but per-bet edge is diluted by the inclusion of the 0.15–0.20 sub-band. The trade-off: lower mean ret/$ (+0.76) but higher n_bets and **the highest total $ produced of any tested band** (+$80K in-sample).

Use this strategy when capital preservation and bet density matter more than per-bet edge — e.g. small-bankroll real-money paper-trade where you want lots of small wins to validate the live data path.`,
    inSample: {
      mean_ret_per_dollar: 0.76,
      total_pnl: 80_000,
      p5: 38_000,
      p_pos: 0.99,
      n_bets: 1402,
      n_markets: 312,
      span_label: "21mo (Aug 2024 – Apr 2026)",
    },
    forward: {
      mean_ret_per_dollar: 0.91,
      total_pnl: 28_000,
      p5: 11_000,
      p_pos: 0.96,
      n_bets: 384,
      n_markets: 142,
      span_label: "Forward-OOS (Jan – Apr 2026, ~3.5mo)",
    },
    perYear: {
      "2024": {
        mean_ret_per_dollar: 0.79,
        total_pnl: 33_000,
        span_label: "Aug – Dec 2024",
      },
      "2025": {
        mean_ret_per_dollar: 0.74,
        total_pnl: 47_000,
        span_label: "Full year 2025",
      },
      "2026": {
        mean_ret_per_dollar: 0.91,
        total_pnl: 28_000,
        span_label: "Jan – Apr 2026 (forward)",
      },
    },
    filters: [
      SHARED_FILTERS.all_cats,
      SHARED_FILTERS.ep_20,
      SHARED_FILTERS.hours72,
      SHARED_FILTERS.vol100,
      SHARED_FILTERS.cap10,
    ],
    knownIssues: `- Mean ret/$ = +0.76 is below the Bar-2 alpha threshold (+1.00). This is a Bar-1 floor strategy — qualified for $1–5K real-money paper trade but not for direct alpha-tier deployment.
- More bets means more cumulative slippage exposure. If real fills consistently slip > 2%, this strategy degrades faster than the tighter alpha strategies.
- Per-bet edge near the lower end of what the favorite-longshot bias provides; sensitive to small shifts in the longshot regime.`,
    barStatus: "Bar 1 floor",
  },

  // ──────────────────────────────────────────────────────────────────────
  // 6. baseline_v1
  // ──────────────────────────────────────────────────────────────────────
  {
    strategyId: "baseline_v1",
    hypothesis: `**Comparison reference**: the original "tighter blanket" strategy from before per-cat R&D, before the volume cap, and before the day-of-week / catalyst filters.

Spec: ep ∈ [0.10, 0.40), cap=10, ≥72h to resolution, **no volume filter**, all tradeable categories. This is the strategy that the V8b random-universe ablation showed could match V8 within $700 — proving the V5–V8 classifier suite added zero per-trade selection skill on top of the entry-price + cap heuristic.

**Purpose on the dashboard**: keep this running so we can demonstrate on live data that each subsequent improvement (volume cap → narrower band → per-cat → skip-Wed → catalyst-future) actually adds edge beyond the blanket bias.`,
    inSample: {
      mean_ret_per_dollar: 0.48,
      total_pnl: 35_000,
      p5: 11_500,
      p_pos: 0.93,
      n_bets: 1087,
      n_markets: 264,
      span_label: "21mo (Aug 2024 – Apr 2026)",
    },
    forward: {
      mean_ret_per_dollar: 0.62,
      total_pnl: 12_500,
      p5: 4_200,
      p_pos: 0.91,
      n_bets: 318,
      n_markets: 121,
      span_label: "Forward-OOS (Jan – Apr 2026, ~3.5mo)",
    },
    perYear: {
      "2024": {
        mean_ret_per_dollar: 0.51,
        total_pnl: 14_000,
        span_label: "Aug – Dec 2024",
      },
      "2025": {
        mean_ret_per_dollar: 0.46,
        total_pnl: 21_000,
        span_label: "Full year 2025",
      },
      "2026": {
        mean_ret_per_dollar: 0.62,
        total_pnl: 12_500,
        span_label: "Jan – Apr 2026 (forward)",
      },
    },
    filters: [
      SHARED_FILTERS.all_cats,
      SHARED_FILTERS.ep_40,
      SHARED_FILTERS.hours72,
      SHARED_FILTERS.cap10,
      {
        name: "No market-volume cap",
        description:
          "Original baseline did not filter by cumulative on-chain volume. High-volume markets (which are more efficiently priced) are NOT excluded.",
        validation:
          "Random-universe ablation confirmed adding the < $100K volume filter to this baseline lifts mean ret/$ by ≈ 0.10. Kept off here so the baseline truly represents pre-improvement state.",
      },
    ],
    knownIssues: `- This strategy is **not deployable** as a standalone — it's a comparison reference.
- Mean ret/$ = +0.48 sits below the Bar-2 alpha threshold; passes 3/4 Bar-1 floor criteria but is borderline.
- Used to demonstrate why each new filter (volume cap, narrow ep band, geo-only, skip-Wed, catalyst-future) adds real edge.
- If this strategy outperforms one of the alpha-tier strategies on live data, it would invalidate the corresponding improvement and require re-validation.`,
    barStatus: "comparison",
  },
];

async function main() {
  console.log(`[seed_methodology] starting with ${ENTRIES.length} entries`);
  for (const e of ENTRIES) {
    const row: NewStrategyMethodology = {
      strategyId: e.strategyId,
      hypothesis: e.hypothesis,
      inSampleMetrics: e.inSample,
      forwardMetrics: e.forward,
      perYearMetrics: e.perYear,
      filterDescriptions: e.filters,
      knownIssues: e.knownIssues,
      barStatus: e.barStatus,
    };
    await db
      .insert(strategyMethodology)
      .values(row)
      .onConflictDoUpdate({
        target: strategyMethodology.strategyId,
        set: {
          hypothesis: row.hypothesis,
          inSampleMetrics: row.inSampleMetrics,
          forwardMetrics: row.forwardMetrics,
          perYearMetrics: row.perYearMetrics,
          filterDescriptions: row.filterDescriptions,
          knownIssues: row.knownIssues,
          barStatus: row.barStatus,
          updatedAt: new Date(),
        },
      });
    console.log(
      `[seed_methodology]   upserted ${e.strategyId} (${e.barStatus})`,
    );
  }
  console.log(`[seed_methodology] done.`);
}

main().catch((e) => {
  console.error("[seed_methodology] FAILED:", e);
  process.exit(1);
});
