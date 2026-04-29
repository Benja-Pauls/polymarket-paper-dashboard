// Reset the strategy poll cursor to N days ago. Useful for backfilling
// the dashboard from historical Goldsky data.
//
// Usage: pnpm exec tsx --env-file=.env.local scripts/reset_cursor.ts [days]

import { neon } from "@neondatabase/serverless";

async function main() {
  const days = Number(process.argv[2] ?? "7");
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const dbUrl =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL_UNPOOLED;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const sql = neon(dbUrl);
  await sql`update strategies set last_poll_ts = ${since} where id = 'tighter_blanket_cap10_3day'`;
  const rows = await sql`select id, last_poll_ts, current_cash from strategies`;
  console.log(`reset cursor to ${since} (${days} days ago)`);
  console.log(rows);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
