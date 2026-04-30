import { neon } from "@neondatabase/serverless";
async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const sql = neon(dbUrl);
  const now = Math.floor(Date.now()/1000);

  // Find the timestamp range of the most recently inserted batch of signals
  const r0 = await sql`
    SELECT MIN(raw_ts)::bigint as min_ts, MAX(raw_ts)::bigint as max_ts, COUNT(*)::int as n
    FROM signals
    WHERE strategy_id='baseline_v1' AND created_at > NOW() - INTERVAL '5 minutes'
  `;
  const r0r = r0[0];
  console.log(`Latest 5-min insert window: signals=${r0r.n}, raw_ts=${r0r.min_ts}..${r0r.max_ts} (span ${r0r.max_ts && r0r.min_ts ? (Number(r0r.max_ts)-Number(r0r.min_ts))/60 : '?'}min)\n`);

  // What categories are signals on, in this window?
  console.log("=== Latest insert: category distribution ===");
  const r = await sql`
    SELECT coalesce(m.category,'(null)') as cat, COUNT(*)::int as n
    FROM signals s
    LEFT JOIN markets m ON m.condition_id = s.market_cid
    WHERE s.strategy_id = 'baseline_v1' AND s.created_at > NOW() - INTERVAL '5 minutes'
    GROUP BY m.category ORDER BY n DESC
  `;
  for (const x of r) console.log(`  ${String(x.cat).padEnd(35)} ${x.n}`);

  // Tradeable_geopolitical signals — what are the prices and resolution status?
  console.log("\n=== Latest insert: TRADEABLE markets — what's the skip distribution? ===");
  const r2 = await sql`
    SELECT s.decision, s.reason, m.category, COUNT(*)::int as n
    FROM signals s
    JOIN markets m ON m.condition_id = s.market_cid
    WHERE s.strategy_id = 'baseline_v1' AND s.created_at > NOW() - INTERVAL '5 minutes'
      AND m.category LIKE 'tradeable_%'
    GROUP BY s.decision, s.reason, m.category
    ORDER BY n DESC LIMIT 25
  `;
  for (const x of r2) console.log(`  ${x.decision.padEnd(5)} ${String(x.n).padStart(3)} cat=${String(x.category).padEnd(22)} ${x.reason}`);

  // Sample 10 most recent BUY trades on tradeable_geopolitical with future res
  console.log("\n=== Most recent geo trades (with future res, any price) - last 10 min ===");
  const r3 = await sql`
    SELECT s.raw_price, s.raw_side, s.decision, s.reason, m.question_text,
           ((m.resolution_timestamp - ${now})/86400.0)::numeric(10,1) as eta_d
    FROM signals s
    JOIN markets m ON m.condition_id = s.market_cid
    WHERE s.strategy_id = 'baseline_v1' AND s.created_at > NOW() - INTERVAL '10 minutes'
      AND m.category = 'tradeable_geopolitical'
      AND m.resolution_timestamp IS NOT NULL
      AND m.resolution_timestamp > ${now}
    ORDER BY s.raw_ts DESC LIMIT 15
  `;
  for (const x of r3) console.log(`  ${x.raw_side} price=${x.raw_price} eta=${x.eta_d}d ${x.decision}: ${String(x.reason||'(BET!)').slice(0,40)} q="${String(x.question_text).slice(0,38)}"`);
}
main().catch(e => { console.error(e); process.exit(1); });
