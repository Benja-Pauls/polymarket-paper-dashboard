import { neon } from "@neondatabase/serverless";
async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const sql = neon(dbUrl);
  const cols = await sql`SELECT column_name FROM information_schema.columns WHERE table_name='markets'`;
  console.log("markets columns:", cols.map(c => c.column_name));
  const now = Math.floor(Date.now()/1000);
  const r = await sql`
    SELECT category,
      COUNT(*)::int as total,
      COUNT(*) FILTER (WHERE resolution_timestamp IS NULL)::int as no_res,
      COUNT(*) FILTER (WHERE resolution_timestamp > ${now})::int as future_res,
      COUNT(*) FILTER (WHERE resolution_timestamp <= ${now})::int as past_res
    FROM markets GROUP BY category ORDER BY total DESC`;
  console.log("\nmarkets by category:");
  for (const x of r) console.log(`  ${String(x.category||'NULL').padEnd(28)} total=${x.total} no_res=${x.no_res} FUTURE=${x.future_res} past=${x.past_res}`);
  
  const r2 = await sql`
    SELECT COUNT(*) FILTER (WHERE resolution_timestamp > ${now})::int as future_total,
           COUNT(*)::int as total
    FROM markets WHERE category IN ('tradeable_geopolitical','tradeable_political','tradeable_corporate','tradeable_crypto')`;
  console.log(`\ntradeable_* with future resolution: ${r2[0].future_total} / ${r2[0].total}`);
}
main().catch(e => { console.error(e); process.exit(1); });
