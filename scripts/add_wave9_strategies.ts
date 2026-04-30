// Add the Wave 9 MIRROR-FAVORITE strategies to the dashboard.
//
// Two variants from the agent's backtest:
//   - wave9_mirror_v1: All-cat mirror, ep [0.10, 0.40), cap=10 — Bar-1 PASS
//     standalone (mean ret/$ +0.507, P5 +$9,542 on $5K)
//   - wave9_mirror_geo_v1: Geo-only mirror — strongest variant (mean ret/$
//     +0.733 on 542 bets), genuinely alpha-tier
//
// Both start at $1000 bankroll / $10 stake (matches the rest of the deck).
//
// Per RESEARCH_AND_STRATEGY.md, mirror cuts are post-hoc on test data. Live
// paper-trade is the next validation step. Tripwires: halt if loss > $500
// in first 60 days, or any 30-day window draws down > $300.

import { neon } from "@neondatabase/serverless";

async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const sql = neon(dbUrl);
  const now = Math.floor(Date.now() / 1000);

  type Spec = {
    id: string;
    name: string;
    description: string;
    paramsJson: Record<string, unknown>;
  };

  const wave9: Spec[] = [
    {
      id: "wave9_mirror_v1",
      name: "wave9_mirror_v1",
      description:
        "MIRROR-FAVORITE all-cat, cap=10. BUYs at orig price ≥ 0.60 are mirrored to bet on the OTHER outcome at (1-price). Synthesized entry must land in [0.10, 0.40). Captures the favorite-longshot bias from the favorite-side angle. Backtest 21mo: mean ret/$ +0.507, P5 +$9,542, P_pos 0.994 (Bar-1 PASS).",
      paramsJson: {
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
        mirror_favorite_min_orig_price: 0.6,
      },
    },
    {
      id: "wave9_mirror_geo_v1",
      name: "wave9_mirror_geo_v1",
      description:
        "MIRROR-FAVORITE geopolitical-only, cap=10. Strongest backtest variant — geo mirror alone delivered mean ret/$ +0.733 on 542 bets in the 21mo test. Same mirror mechanic as wave9_mirror_v1 but restricted to tradeable_geopolitical, where the favorite-longshot bias is most pronounced.",
      paramsJson: {
        ep_lo: 0.1,
        ep_hi: 0.4,
        slippage: 0.02,
        categories: ["tradeable_geopolitical"],
        cap_per_market: 10,
        min_hours_to_res: 72,
        max_hours_to_res: 2160, // 90d
        max_market_volume: null,
        mirror_favorite_min_orig_price: 0.6,
      },
    },
  ];

  for (const s of wave9) {
    const r = await sql`
      INSERT INTO strategies (id, name, description, params_json, starting_bankroll, current_cash, stake, status, last_poll_ts)
      VALUES (
        ${s.id}, ${s.name}, ${s.description},
        ${JSON.stringify(s.paramsJson)}::jsonb,
        1000, 1000, 10, 'active',
        ${now}
      )
      ON CONFLICT (id) DO UPDATE SET
        params_json = EXCLUDED.params_json,
        description = EXCLUDED.description,
        updated_at = NOW()
      RETURNING id, current_cash, stake
    `;
    const row = r[0] as { id: string; current_cash: number; stake: number };
    console.log(`✓ ${row.id}  cash=$${row.current_cash}  stake=$${row.stake}`);
  }

  console.log(`\nDone. Active strategies will start receiving signals on next /api/cron/poll fire.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
