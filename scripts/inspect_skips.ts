// Skip-reason inspection. Usage:
//   pnpm exec tsx --env-file=.env.local scripts/inspect_skips.ts
import { neon } from "@neondatabase/serverless";

async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const sql = neon(dbUrl);

  console.log("--- top skip reasons across active strategies ---");
  const reasons = await sql`
    SELECT reason, COUNT(*)::int as n
    FROM signals
    WHERE decision = 'skip' AND strategy_id IN (
      SELECT id FROM strategies WHERE status = 'active'
    )
    GROUP BY reason
    ORDER BY n DESC
    LIMIT 30
  `;
  for (const r of reasons) console.log(`  ${String(r.n).padStart(5)}  ${r.reason}`);

  console.log("\n--- markets summary ---");
  const m = await sql`
    SELECT category, COUNT(*)::int as n,
           COUNT(*) FILTER (WHERE resolution_timestamp IS NOT NULL)::int as n_resolved,
           COUNT(*) FILTER (WHERE resolution_timestamp IS NULL)::int as n_unresolved
    FROM markets
    GROUP BY category
    ORDER BY n DESC
  `;
  for (const r of m) console.log(`  ${String(r.category || 'NULL').padEnd(30)} total=${r.n} resolved=${r.n_resolved} unresolved=${r.n_unresolved}`);

  console.log("\n--- catalysts loaded ---");
  const c = await sql`SELECT COUNT(*)::int as n FROM market_catalysts`;
  console.log(`  market_catalysts: ${c[0].n}`);

  console.log("\n--- cron cursor ---");
  const cur = await sql`SELECT * FROM cron_cursor LIMIT 5`;
  for (const r of cur) console.log(`  ${JSON.stringify(r)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
