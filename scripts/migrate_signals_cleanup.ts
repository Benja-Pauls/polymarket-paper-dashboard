// One-shot migration: reclaim the 461 MB consumed by dead skip-signal rows
// in the `signals` table. Brings the DB from ~490 MB → ~30 MB without
// requiring a Neon plan upgrade.
//
// Why this works on Free tier (where naive VACUUM FULL would fail):
//
//   1. DELETE FROM signals WHERE decision='skip'
//      -> Marks rows dead. Doesn't shrink the file (Postgres keeps dead
//         tuples in place until VACUUM/VACUUM FULL).
//      -> No new disk consumed; doesn't move the cap needle.
//
//   2. REINDEX TABLE signals
//      -> Rebuilds all of the table's indexes from live data only.
//      -> Live data after step 1 is ~700 rows, so new indexes are <1 MB.
//      -> Once the new index is built, the old (195 MB) index is dropped.
//      -> Net: frees ~194 MB on disk. THIS is what gets us off the cap.
//
//   3. VACUUM FULL signals
//      -> Rewrites the table file from live data only.
//      -> Peak temp ~1 MB during rebuild (bet rows are tiny).
//      -> After step 2 we have ~217 MB headroom, so this is trivially safe.
//      -> Net: frees ~264 MB on disk.
//
// Final: signals table ~5 MB total, DB ~30 MB. 5+ year runway on Free tier
// given current growth (~15 MB/year of bet signals).
//
// Run:
//   pnpm tsx --env-file=.env.local scripts/migrate_signals_cleanup.ts            # dry-run, no SQL fired
//   pnpm tsx --env-file=.env.local scripts/migrate_signals_cleanup.ts --execute  # actually run
//
// Concurrency: REINDEX takes an EXCLUSIVE lock on the indexes; VACUUM FULL
// takes ACCESS EXCLUSIVE on the table. Both will block any concurrent poll
// cron INSERTs for the duration of this script (~few seconds total, since
// live data is tiny). If a poll cron fires during the script, its INSERTs
// queue up and complete normally once the locks release. Best run right
// AFTER a successful poll firing to give a 14-min gap before the next one.

import { Client } from "@neondatabase/serverless";

type Row = Record<string, unknown>;

const EXECUTE = process.argv.includes("--execute");

async function main() {
  const url =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL_UNPOOLED (or DATABASE_URL) required");

  // We MUST use the unpooled URL because:
  //  - The Neon HTTP serverless driver auto-wraps each query in a
  //    transaction. VACUUM FULL cannot run inside a transaction.
  //  - The pooled URL routes through PgBouncer in transaction mode, which
  //    also breaks VACUUM FULL.
  // Both REINDEX and VACUUM FULL need a direct WebSocket session connection.
  if (url.includes("pooler")) {
    console.warn(
      `[migrate] WARNING: connection string routes through "pooler" — VACUUM FULL may fail. Set DATABASE_URL_UNPOOLED in .env.local.`,
    );
  }

  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    // ── Pre-flight: capture starting state ────────────────────────────
    console.log(`\n${EXECUTE ? "===== EXECUTE MODE =====" : "===== DRY RUN (use --execute to apply) ====="}\n`);

    const dbBefore = await sizeOf(client);
    const sigBefore = await tableSize(client, "signals");
    const skipCount = (
      await client.query(`SELECT count(*)::int AS n FROM signals WHERE decision='skip'`)
    ).rows[0] as Row;
    const betCount = (
      await client.query(`SELECT count(*)::int AS n FROM signals WHERE decision='bet'`)
    ).rows[0] as Row;

    console.log(`Pre-flight:`);
    console.log(`  DB total:           ${dbBefore.pretty} (${dbBefore.bytes} bytes)`);
    console.log(`  signals total:      ${sigBefore.total_pretty}`);
    console.log(`  signals table data: ${sigBefore.table_pretty}`);
    console.log(`  signals indexes:    ${sigBefore.index_pretty}`);
    console.log(`  signals.skip rows:  ${skipCount.n}`);
    console.log(`  signals.bet rows:   ${betCount.n}  ← these are KEPT`);
    console.log(``);

    if (!EXECUTE) {
      console.log(
        `Nothing was modified. Re-run with --execute to apply the 3-step migration:\n`,
      );
      console.log(`  Step 1: DELETE FROM signals WHERE decision='skip'   (${skipCount.n} rows)`);
      console.log(`  Step 2: REINDEX TABLE signals                       (rebuild all indexes)`);
      console.log(`  Step 3: VACUUM FULL signals                         (rewrite table file)`);
      console.log(``);
      console.log(
        `Expected final DB total: ~30 MB (down from ${dbBefore.pretty}).`,
      );
      return;
    }

    // ── Step 1: DELETE skip rows ─────────────────────────────────────
    console.log(`[step 1/3] DELETE FROM signals WHERE decision='skip' ...`);
    const t1 = Date.now();
    const del = await client.query(`DELETE FROM signals WHERE decision='skip'`);
    console.log(
      `  ✓ deleted ${del.rowCount} rows in ${Date.now() - t1}ms`,
    );
    const sizeAfter1 = await sizeOf(client);
    console.log(
      `  DB total after step 1: ${sizeAfter1.pretty}  (no on-disk shrink expected — dead tuples remain until VACUUM)`,
    );

    // ── Step 2: REINDEX (the load-bearing step for free-tier feasibility) ─
    console.log(`\n[step 2/3] REINDEX TABLE signals ...`);
    const t2 = Date.now();
    await client.query(`REINDEX TABLE signals`);
    console.log(`  ✓ reindexed in ${Date.now() - t2}ms`);
    const sizeAfter2 = await sizeOf(client);
    const sigAfter2 = await tableSize(client, "signals");
    console.log(`  DB total after step 2: ${sizeAfter2.pretty}`);
    console.log(`  signals indexes:       ${sigAfter2.index_pretty}  ← should be ~1 MB`);
    console.log(
      `  Headroom freed:        ${prettyBytes(dbBefore.bytes - sizeAfter2.bytes)} (now safe to VACUUM FULL)`,
    );

    // ── Step 3: VACUUM FULL (frees the table file) ────────────────────
    console.log(`\n[step 3/3] VACUUM FULL signals ...`);
    const t3 = Date.now();
    await client.query(`VACUUM FULL signals`);
    console.log(`  ✓ vacuum-full in ${Date.now() - t3}ms`);

    // ── Post-flight: report final state ───────────────────────────────
    const dbAfter = await sizeOf(client);
    const sigAfter = await tableSize(client, "signals");
    console.log(`\n===== FINAL =====`);
    console.log(`  DB total:           ${dbAfter.pretty}  (was ${dbBefore.pretty})`);
    console.log(`  signals total:      ${sigAfter.total_pretty}`);
    console.log(`  signals table data: ${sigAfter.table_pretty}`);
    console.log(`  signals indexes:    ${sigAfter.index_pretty}`);
    console.log(`  Reclaimed:          ${prettyBytes(dbBefore.bytes - dbAfter.bytes)}`);
    console.log(``);
    console.log(`✅ Cleanup complete. Cron errors caused by code 53100 (size cap) should stop.`);
  } finally {
    await client.end();
  }
}

async function sizeOf(client: Client): Promise<{ pretty: string; bytes: number }> {
  const r = await client.query(`
    SELECT pg_size_pretty(pg_database_size(current_database())) AS pretty,
           pg_database_size(current_database())::bigint AS bytes
  `);
  const row = r.rows[0] as Row;
  return { pretty: row.pretty as string, bytes: Number(row.bytes) };
}

async function tableSize(
  client: Client,
  name: string,
): Promise<{
  total_pretty: string;
  table_pretty: string;
  index_pretty: string;
}> {
  const r = await client.query(
    `
    SELECT
      pg_size_pretty(pg_total_relation_size($1::regclass)) AS total_pretty,
      pg_size_pretty(pg_relation_size($1::regclass))       AS table_pretty,
      pg_size_pretty(pg_indexes_size($1::regclass))        AS index_pretty
  `,
    [name],
  );
  return r.rows[0] as { total_pretty: string; table_pretty: string; index_pretty: string };
}

function prettyBytes(bytes: number): string {
  const sign = bytes < 0 ? "-" : "";
  const b = Math.abs(bytes);
  if (b >= 1024 * 1024 * 1024) return `${sign}${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (b >= 1024 * 1024) return `${sign}${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b >= 1024) return `${sign}${(b / 1024).toFixed(1)} kB`;
  return `${sign}${b} B`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
