// Reset all strategy cursors to NOW - 30 minutes (so the first cron run after
// switching data sources doesn't try to backfill the 49h stale window).
import { neon } from "@neondatabase/serverless";
async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const sql = neon(dbUrl);
  const newCursor = Math.floor(Date.now()/1000) - 30*60;
  console.log(`Setting all strategy.last_poll_ts to ${newCursor} (NOW - 30min = ${new Date(newCursor*1000).toISOString()})`);
  await sql`UPDATE strategies SET last_poll_ts = ${newCursor}, updated_at = NOW() WHERE 1=1`;
  console.log("Done.");
  const r = await sql`SELECT id, last_poll_ts FROM strategies ORDER BY id`;
  for (const x of r) console.log(`  ${String(x.id).padEnd(35)} last_poll_ts=${x.last_poll_ts}`);
}
main().catch(e => { console.error(e); process.exit(1); });
