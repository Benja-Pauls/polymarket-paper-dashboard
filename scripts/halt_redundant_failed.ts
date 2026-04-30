// Halt the 6 strategies the comprehensive backtest + walk-forward identified
// as redundant or failed. Keeps the leaderboard focused on the 4 surviving
// strategies. Live data accumulates only on the survivors going forward.
//
// Why halt rather than delete: the historical bet history (positions table)
// stays attached to the strategy id, so we can compute realized P&L when
// these strategies' open positions resolve.
//
// Per RESEARCH_AND_STRATEGY decision log + results/walkforward_deployed_deck.md.

import { neon } from "@neondatabase/serverless";

const HALT: Array<{ id: string; reason: string }> = [
  // REDUNDANT — dominated by a stronger variant
  { id: "geo_deep_longshot_v1", reason: "rho 0.98 with geo_v2_skipwed; v2 dominates by skipping Wed-UTC loss cohort" },
  { id: "wave9_mirror_geo_v1", reason: "100% bet subset of wave9_mirror_v1; smaller P5 due to concentration" },
  { id: "all_cat_tight_v1", reason: "96% bet subset of all_cat_conservative_v1; thin volume" },
  { id: "all_cat_conservative_v1", reason: "Dominated by baseline_v1 (same universe, narrower ep band, lower P5)" },
  // FAILED — fail Bar-1 strict on the comprehensive re-test
  { id: "geo_deep_longshot_v3_catalyst", reason: "FAILS Bar-1: top-1 conc 32%, only 4.4 bpm; CLAUDE.md Bar-2 claim doesn't survive clean re-test" },
  { id: "geo_deep_longshot_v4_catalyst_3d", reason: "FAILS Bar-1: top-1 conc 37%, 1.6 bpm, leave-top-out P5 = -$173; only 5 markets total" },
];

async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const sql = neon(dbUrl);

  for (const h of HALT) {
    const r = await sql`
      UPDATE strategies
      SET status = 'retired',
          halt_reason = ${h.reason},
          updated_at = NOW()
      WHERE id = ${h.id} AND status = 'active'
      RETURNING id, status
    `;
    if (r.length === 0) {
      console.log(`  - ${h.id} (already not active)`);
    } else {
      console.log(`  ✓ ${h.id} → retired`);
    }
  }

  // Verify final active count.
  const a = await sql`SELECT id FROM strategies WHERE status = 'active' ORDER BY id`;
  console.log(`\nActive strategies (${a.length}):`);
  for (const s of a) console.log(`  - ${s.id}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
