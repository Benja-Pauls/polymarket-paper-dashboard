/**
 * Test the new sync-open-markets logic locally against the live DB.
 * Re-implements the runOnce flow inline so we don't have to spin up Next.
 *
 * Usage:
 *   pnpm exec tsx --env-file=.env.local scripts/diag_test_fix.ts
 */
import { neon } from "@neondatabase/serverless";
import {
  fetchOpenMarkets,
  parseEndTs,
} from "../src/lib/gamma/index";

const TRADEABLE_CATS = [
  "tradeable_geopolitical",
  "tradeable_political",
  "tradeable_corporate",
  "tradeable_crypto",
  "tradeable_finance",
  "tradeable_business",
  "tradeable_macro",
  "tradeable_judicial",
  "tradeable_other",
];

async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const sql = neon(dbUrl);
  const nowS = Math.floor(Date.now() / 1000);

  // BEFORE
  const before = await sql`
    SELECT
      coalesce(category, '(null)') as category,
      COUNT(*) FILTER (WHERE resolution_timestamp IS NULL)::int as n_null,
      COUNT(*) FILTER (WHERE resolution_timestamp = 0)::int as n_archived,
      COUNT(*) FILTER (WHERE resolution_timestamp > ${nowS})::int as n_future,
      COUNT(*)::int as n_total
    FROM markets
    WHERE category = ANY(${TRADEABLE_CATS})
    GROUP BY category
    ORDER BY category
  `;
  console.log("=== BEFORE fix run ===");
  let beforeNullTotal = 0;
  for (const x of before) {
    beforeNullTotal += Number(x.n_null);
    console.log(
      `  ${String(x.category).padEnd(28)} null=${String(x.n_null).padStart(4)}  archived(0)=${String(x.n_archived).padStart(4)}  future=${String(x.n_future).padStart(4)}  total=${String(x.n_total).padStart(4)}`,
    );
  }
  console.log(`  TOTAL NULL across tradeable_*: ${beforeNullTotal}`);

  // 1. Pull open markets with new defaults (20K rows, 365d cap).
  console.log(`\n=== Calling fetchOpenMarkets({ maxRows: 20000, futureOnly: true, maxEndDateDays: 365 }) ===`);
  const t0 = Date.now();
  const openList = await fetchOpenMarkets({
    maxRows: 20000,
    futureOnly: true,
    maxEndDateDays: 365,
  });
  console.log(`  Got ${openList.length} markets in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 2. Upsert resolution_timestamp for any cid we have in DB whose ts is NULL.
  // Build a cid -> endTs map for quick lookup.
  const cidToEndTs = new Map<string, number>();
  for (const m of openList) {
    const ts = parseEndTs(m.endDate);
    if (ts != null && ts > nowS) {
      cidToEndTs.set(m.conditionId.toLowerCase(), ts);
    }
  }
  console.log(`  ${cidToEndTs.size} of those have valid future endDate.`);

  // 3. Apply: update markets where condition_id IN (cidToEndTs) AND res_ts IS NULL.
  const cidsArr = Array.from(cidToEndTs.keys());
  const tsArr = cidsArr.map((c) => cidToEndTs.get(c)!);
  if (cidsArr.length > 0) {
    await sql`
      UPDATE markets m
      SET resolution_timestamp = u.ts,
          updated_at = now()
      FROM (
        SELECT unnest(${cidsArr}::text[]) as cid,
               unnest(${tsArr}::bigint[]) as ts
      ) u
      WHERE m.condition_id = u.cid
        AND m.resolution_timestamp IS NULL
    `;
  }
  console.log(`  Bulk-applied to DB.`);

  // 4. Stale-mark pass. NULL-res-ts tradeable_* cids that did NOT appear in
  // the open list are likely closed → sentinel-mark with ts=0.
  const seenCids = new Set(openList.map((m) => m.conditionId.toLowerCase()));
  const stillNull = await sql`
    SELECT condition_id
    FROM markets
    WHERE category = ANY(${TRADEABLE_CATS})
      AND resolution_timestamp IS NULL
  `;
  const stale: string[] = [];
  for (const r of stillNull as Array<Record<string, unknown>>) {
    const cid = String(r.condition_id).toLowerCase();
    if (!seenCids.has(cid)) stale.push(cid);
  }
  console.log(`\n=== Stale-mark pass: ${stale.length} cids not in open list ===`);
  if (stale.length > 0) {
    await sql`
      UPDATE markets
      SET resolution_timestamp = 0,
          updated_at = now()
      WHERE condition_id = ANY(${stale}::text[])
        AND resolution_timestamp IS NULL
    `;
    console.log(`  Stale-marked ${stale.length}.`);
  }

  // AFTER
  const after = await sql`
    SELECT
      coalesce(category, '(null)') as category,
      COUNT(*) FILTER (WHERE resolution_timestamp IS NULL)::int as n_null,
      COUNT(*) FILTER (WHERE resolution_timestamp = 0)::int as n_archived,
      COUNT(*) FILTER (WHERE resolution_timestamp > ${nowS})::int as n_future,
      COUNT(*)::int as n_total
    FROM markets
    WHERE category = ANY(${TRADEABLE_CATS})
    GROUP BY category
    ORDER BY category
  `;
  console.log("\n=== AFTER fix run ===");
  let afterNullTotal = 0;
  for (const x of after) {
    afterNullTotal += Number(x.n_null);
    console.log(
      `  ${String(x.category).padEnd(28)} null=${String(x.n_null).padStart(4)}  archived(0)=${String(x.n_archived).padStart(4)}  future=${String(x.n_future).padStart(4)}  total=${String(x.n_total).padStart(4)}`,
    );
  }
  console.log(`  TOTAL NULL across tradeable_*: ${afterNullTotal}`);
  console.log(`\nDelta: ${beforeNullTotal} → ${afterNullTotal} NULLs (${beforeNullTotal - afterNullTotal} resolved)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
