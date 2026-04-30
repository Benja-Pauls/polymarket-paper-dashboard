import { neon } from "@neondatabase/serverless";
async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const sql = neon(dbUrl);
  const now = Math.floor(Date.now()/1000);
  const since = now - 30*60;

  // Categories of markets touched in last 30 min
  console.log("\n=== Categories of markets touched in last 30 min (via baseline signals) ===");
  const r = await sql`
    SELECT
      coalesce(m.category, '(null)') as category,
      COUNT(DISTINCT s.market_cid)::int as n_markets,
      COUNT(*)::int as n_trades
    FROM signals s
    LEFT JOIN markets m ON m.condition_id = s.market_cid
    WHERE s.strategy_id = 'baseline_v1' AND s.raw_ts >= ${since}
    GROUP BY m.category
    ORDER BY n_trades DESC
  `;
  for (const x of r) console.log(`  ${String(x.category).padEnd(35)} markets=${String(x.n_markets).padStart(4)}  trades=${String(x.n_trades).padStart(5)}`);

  // Time-to-resolution distribution for markets in tradeable_geopolitical
  console.log("\n=== resolution_timestamp distribution for tradeable_geopolitical markets ===");
  const r2 = await sql`
    SELECT
      CASE
        WHEN m.resolution_timestamp IS NULL THEN '(null)'
        WHEN m.resolution_timestamp - ${now} < 0 THEN 'past'
        WHEN m.resolution_timestamp - ${now} < 3*86400 THEN '<3d'
        WHEN m.resolution_timestamp - ${now} < 30*86400 THEN '3d-30d'
        WHEN m.resolution_timestamp - ${now} < 60*86400 THEN '30d-60d'
        WHEN m.resolution_timestamp - ${now} < 180*86400 THEN '60d-180d'
        ELSE '>180d'
      END as bucket,
      COUNT(*)::int as n
    FROM markets m
    WHERE m.category IN ('tradeable_geopolitical','tradeable_political','tradeable_finance','tradeable_business','tradeable_macro','tradeable_judicial','tradeable_other')
    GROUP BY bucket
    ORDER BY bucket
  `;
  for (const x of r2) console.log(`  ${String(x.bucket).padEnd(10)} ${x.n}`);

  // Counts of all markets by category
  console.log("\n=== ALL markets in DB by category ===");
  const r3 = await sql`SELECT coalesce(category,'(null)') as category, COUNT(*)::int as n FROM markets GROUP BY category ORDER BY n DESC`;
  for (const x of r3) console.log(`  ${String(x.category).padEnd(35)} ${x.n}`);

  // Recent (in last 24h trade) markets that are NULL-category (lazy classify)
  console.log("\n=== NULL-category markets touched in last 30 min (need lazy-classify) ===");
  const r4 = await sql`
    SELECT s.market_cid, COUNT(*)::int as n_trades
    FROM signals s
    LEFT JOIN markets m ON m.condition_id = s.market_cid
    WHERE s.strategy_id = 'baseline_v1' AND s.raw_ts >= ${since} AND m.category IS NULL
    GROUP BY s.market_cid
    ORDER BY n_trades DESC
    LIMIT 10
  `;
  for (const x of r4) console.log(`  ${String(x.market_cid).slice(0,18)}...  trades=${x.n_trades}`);

  // Show market questions for the NULL-category ones (should be classified)
  if (r4.length > 0) {
    console.log("\n=== Question text for NULL-category recent markets ===");
    const cids = r4.map(x => x.market_cid);
    const r5 = await sql`SELECT condition_id, question_text, category, resolution_timestamp FROM markets WHERE condition_id = ANY(${cids})`;
    for (const x of r5) {
      const eta = x.resolution_timestamp ? `${((Number(x.resolution_timestamp)-now)/86400).toFixed(1)}d` : "(null)";
      console.log(`  cid=${String(x.condition_id).slice(0,16)}  cat=${x.category}  res=${eta}  q="${String(x.question_text||'(null)').slice(0,80)}"`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
