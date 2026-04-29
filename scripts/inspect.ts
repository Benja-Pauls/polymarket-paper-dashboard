// Quick DB inspection script. Usage:
//   pnpm exec tsx --env-file=.env.local scripts/inspect.ts
import { neon } from "@neondatabase/serverless";

async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const sql = neon(dbUrl);

  console.log("--- strategies ---");
  const r0 =
    await sql`select id, name, status, current_cash::float, last_poll_ts, params_json from strategies order by status, name`;
  for (const s of r0) {
    console.log(
      `  ${String(s.status).padEnd(10)} ${String(s.id).padEnd(30)} cash=$${s.current_cash} params=${JSON.stringify(s.params_json)}`,
    );
  }

  console.log("\n--- signals by strategy + decision ---");
  const r2 =
    await sql`select strategy_id, decision, count(*)::int as n from signals group by strategy_id, decision order by strategy_id, decision`;
  console.log(r2);

  console.log("\n--- positions by strategy ---");
  const r3 =
    await sql`select strategy_id, count(*)::int as n_total, count(settled_ts)::int as n_settled from positions group by strategy_id order by strategy_id`;
  console.log(r3);

  console.log("\n--- markets known with category ---");
  const r4 =
    await sql`select category, count(*)::int as n from markets group by category order by n desc limit 20`;
  console.log(r4);

  console.log("\n--- daily snapshots (last 8) ---");
  const r5 =
    await sql`select strategy_id, snapshot_date, cash, n_open_positions, cumulative_pnl, n_bets_total from daily_snapshots order by snapshot_date desc, strategy_id limit 8`;
  console.log(r5);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
