import { neon } from "@neondatabase/serverless";
async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const sql = neon(dbUrl);
  const now = Math.floor(Date.now()/1000);

  // Total bets per strategy
  console.log("\n=== Total bets per strategy ===");
  const r = await sql`
    SELECT p.strategy_id, COUNT(*)::int as n_bets, MAX(p.entry_ts)::bigint as last_bet
    FROM positions p
    GROUP BY p.strategy_id
    ORDER BY p.strategy_id
  `;
  for (const x of r) {
    const age_h = ((now - Number(x.last_bet))/3600).toFixed(1);
    console.log(`  ${String(x.strategy_id).padEnd(35)} bets=${String(x.n_bets).padStart(4)} last=${age_h}h ago`);
  }

  // Bets in the last 24 hours (since data-api migration)
  console.log("\n=== Bets in last 24 hours ===");
  const r2 = await sql`
    SELECT p.strategy_id, p.market_cid, p.entry_price, p.bet_outcome, p.entry_ts, m.question_text, m.category
    FROM positions p
    LEFT JOIN markets m ON m.condition_id = p.market_cid
    WHERE p.entry_ts >= ${now - 24*3600}
    ORDER BY p.entry_ts DESC
    LIMIT 20
  `;
  if (r2.length === 0) {
    console.log("  (none yet)");
  } else {
    for (const x of r2) {
      const age_min = ((now - Number(x.entry_ts))/60).toFixed(0);
      console.log(`  ${age_min}m ago | ${String(x.strategy_id).padEnd(30)} | ${x.bet_outcome} @ ${x.entry_price} | ${String(x.question_text||'').slice(0,55)}`);
    }
  }

  // Total signals processed
  console.log("\n=== Total signals processed ===");
  const r3 = await sql`SELECT COUNT(*)::int as n FROM signals`;
  console.log(`  Total signals: ${r3[0].n.toLocaleString()}`);
  
  const r4 = await sql`SELECT decision, COUNT(*)::int as n FROM signals GROUP BY decision`;
  for (const x of r4) console.log(`  ${x.decision}: ${x.n.toLocaleString()}`);
}
main().catch(e => { console.error(e); process.exit(1); });
