// Set explicit max_hours_to_res on each strategy. Previously most strategies
// had no value set, so the strategy code default of 720h (30d) was applied.
// User's stated concern: don't bet on markets resolving > 6 months out.
// Compromise: 60-90d cap on broader strategies, 30-60d on tighter ones.
//
// Diagnostic context (2026-04-29 22:00 UTC): with the 30d default, strategies
// were skipping eligible trades on markets like "Starmer out by June 30 2026?"
// (eta 61.6d) — exactly the kind of geo bet our research validates.
import { neon } from "@neondatabase/serverless";

async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const sql = neon(dbUrl);

  const updates: Array<{ id: string; max_hours: number | null; rationale: string }> = [
    { id: "baseline_v1", max_hours: 2160, rationale: "broadest baseline, 90d window" },
    { id: "all_cat_conservative_v1", max_hours: 2160, rationale: "broad conservative, 90d" },
    { id: "all_cat_tight_v1", max_hours: 1440, rationale: "tight strategy, 60d" },
    { id: "geo_deep_longshot_v1", max_hours: 2160, rationale: "geo longshot, 90d (geo res slow)" },
    { id: "geo_deep_longshot_v2_skipwed", max_hours: 2160, rationale: "geo longshot v2, 90d" },
    { id: "geo_deep_longshot_v3_catalyst", max_hours: 2160, rationale: "geo + catalyst, 90d" },
    { id: "geo_deep_longshot_v4_catalyst_3d", max_hours: 1440, rationale: "geo + catalyst 3d, 60d" },
    { id: "v4_broad_clean_v1", max_hours: 720, rationale: "tight 30d (research baseline)" },
  ];

  for (const u of updates) {
    const r = await sql`
      UPDATE strategies
      SET params_json = jsonb_set(
        params_json::jsonb,
        '{max_hours_to_res}',
        ${u.max_hours}::text::jsonb,
        true
      ),
      updated_at = NOW()
      WHERE id = ${u.id}
      RETURNING id, params_json
    `;
    if (r.length === 0) {
      console.log(`[skip] ${u.id} not found`);
      continue;
    }
    const got = (r[0].params_json as any).max_hours_to_res;
    console.log(`✓ ${String(u.id).padEnd(35)} max_hours_to_res=${got} (${(got/24).toFixed(0)}d) — ${u.rationale}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
