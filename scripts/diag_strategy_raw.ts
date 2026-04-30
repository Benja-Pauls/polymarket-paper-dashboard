import { neon } from "@neondatabase/serverless";
async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const sql = neon(dbUrl);
  const r = await sql`SELECT id, params_json FROM strategies WHERE id IN ('baseline_v1','all_cat_tight_v1','geo_deep_longshot_v1','v4_broad_clean_v1') ORDER BY id`;
  for (const s of r) {
    console.log(`\n=== ${s.id} ===`);
    console.log(JSON.stringify(s.params_json, null, 2));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
