// Quick DB inspection script. Usage:
//   pnpm exec tsx --env-file=.env.local scripts/inspect.ts
import { neon } from "@neondatabase/serverless";

async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const sql = neon(dbUrl);

  console.log("--- signals by reason (top 10) ---");
  const r1 =
    await sql`select reason, count(*)::int as n from signals where strategy_id = 'tighter_blanket_cap10_3day' group by reason order by n desc limit 10`;
  console.log(r1);

  console.log("\n--- signals by decision ---");
  const r2 =
    await sql`select decision, count(*)::int as n from signals group by decision`;
  console.log(r2);

  console.log("\n--- positions ---");
  const r3 = await sql`select count(*)::int as n from positions`;
  console.log(r3);

  console.log("\n--- markets known with category null ---");
  const r4 =
    await sql`select category, count(*)::int as n from markets group by category order by n desc limit 20`;
  console.log(r4);

  console.log("\n--- daily snapshots ---");
  const r5 =
    await sql`select snapshot_date, cash, n_open_positions, cumulative_pnl, n_bets_total from daily_snapshots order by snapshot_date desc limit 5`;
  console.log(r5);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
