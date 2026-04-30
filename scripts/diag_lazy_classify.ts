import { fetchMarketsByConditions } from "@/lib/gamma";
import { neon } from "@neondatabase/serverless";

async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const sql = neon(dbUrl);
  const now = Math.floor(Date.now()/1000);
  const since = now - 30*60;

  // Get top 20 NULL-category condition IDs touched in last 30 min
  const r = await sql`
    SELECT s.market_cid, COUNT(*)::int as n_trades
    FROM signals s
    LEFT JOIN markets m ON m.condition_id = s.market_cid
    WHERE s.strategy_id = 'baseline_v1' AND s.raw_ts >= ${since} AND m.category IS NULL
    GROUP BY s.market_cid
    ORDER BY n_trades DESC
    LIMIT 20
  `;
  const cids = r.map(x => x.market_cid as string);
  console.log(`Probing Gamma for ${cids.length} high-volume NULL-category markets...`);

  const gamma = await fetchMarketsByConditions({ conditionIds: cids });
  console.log(`Gamma returned ${gamma.size} matches\n`);

  for (const cid of cids) {
    const g = gamma.get(cid);
    const trades = r.find(x => x.market_cid === cid)?.n_trades;
    if (g) {
      const eta = g.endDate ? Math.floor((Date.parse(g.endDate)/1000 - now) / 3600) : null;
      console.log(`  ${cid.slice(0,18)}... trades=${trades}  GAMMA: q="${(g.question||'').slice(0,60)}" cat=${g.category} eta=${eta}h closed=${g.closed} active=${g.active}`);
    } else {
      console.log(`  ${cid.slice(0,18)}... trades=${trades}  NOT IN GAMMA`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
