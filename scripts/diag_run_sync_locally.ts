/**
 * Run the new sync-open-markets logic locally (without spinning up Next).
 * Just to verify the backfill pass closes the resolution_timestamp gap.
 *
 * Usage:
 *   pnpm exec tsx --env-file=.env.local scripts/diag_run_sync_locally.ts
 */
import { neon } from "@neondatabase/serverless";
import {
  fetchMarketsByConditions,
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

  // BEFORE counts.
  const before = await sql`
    SELECT
      coalesce(category, '(null)') as category,
      COUNT(*) FILTER (WHERE resolution_timestamp IS NULL)::int as n_null,
      COUNT(*) FILTER (WHERE resolution_timestamp > ${nowS})::int as n_future,
      COUNT(*)::int as n_total
    FROM markets
    WHERE category = ANY(${TRADEABLE_CATS})
    GROUP BY category
    ORDER BY category
  `;
  console.log("=== BEFORE backfill ===");
  for (const x of before) {
    console.log(
      `  ${String(x.category).padEnd(28)} null=${String(x.n_null).padStart(4)}  future=${String(x.n_future).padStart(4)}  total=${String(x.n_total).padStart(4)}`,
    );
  }

  // Pull all NULL-res-ts tradeable_* cids.
  const targets = await sql`
    SELECT condition_id
    FROM markets
    WHERE category = ANY(${TRADEABLE_CATS})
      AND resolution_timestamp IS NULL
    LIMIT 2000
  `;
  console.log(`\n=== Backfill: ${targets.length} cids to look up on Gamma ===`);
  if (targets.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const cids = (targets as Array<Record<string, unknown>>).map((t) => String(t.condition_id));
  const t0 = Date.now();
  const found = await fetchMarketsByConditions({ conditionIds: cids });
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Gamma returned ${found.size} markets in ${elapsedSec}s`);

  // Build update batches
  type Update = { cid: string; ts: number; archived: boolean };
  const updates: Update[] = [];
  for (const cid of cids) {
    const m = found.get(cid);
    if (!m) {
      updates.push({ cid, ts: 0, archived: true });
      continue;
    }
    const ts = parseEndTs(m.endDate);
    if (ts != null && ts > nowS) {
      updates.push({ cid, ts, archived: false });
    } else {
      updates.push({ cid, ts: 0, archived: true });
    }
  }

  const nResolved = updates.filter((u) => !u.archived).length;
  const nArchived = updates.filter((u) => u.archived).length;
  console.log(`  Resolved (future endDate found): ${nResolved}`);
  console.log(`  Sentinel-archived (no/past endDate): ${nArchived}`);

  // UNNEST update.
  const cidsArr = updates.map((u) => u.cid);
  const tsArr = updates.map((u) => u.ts);
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

  // AFTER counts.
  const after = await sql`
    SELECT
      coalesce(category, '(null)') as category,
      COUNT(*) FILTER (WHERE resolution_timestamp IS NULL)::int as n_null,
      COUNT(*) FILTER (WHERE resolution_timestamp > ${nowS})::int as n_future,
      COUNT(*) FILTER (WHERE resolution_timestamp = 0)::int as n_archived,
      COUNT(*)::int as n_total
    FROM markets
    WHERE category = ANY(${TRADEABLE_CATS})
    GROUP BY category
    ORDER BY category
  `;
  console.log("\n=== AFTER backfill ===");
  for (const x of after) {
    console.log(
      `  ${String(x.category).padEnd(28)} null=${String(x.n_null).padStart(4)}  future=${String(x.n_future).padStart(4)}  archived(ts=0)=${String(x.n_archived).padStart(4)}  total=${String(x.n_total).padStart(4)}`,
    );
  }

  // Sample check: 5 random tradeable_geopolitical markets — what's their state now?
  const sample = await sql`
    SELECT condition_id, resolution_timestamp, question_text
    FROM markets
    WHERE category = 'tradeable_geopolitical'
      AND resolution_timestamp > ${nowS}
    ORDER BY random()
    LIMIT 5
  `;
  console.log("\n=== Sample 5 tradeable_geopolitical with future res_ts ===");
  for (const x of sample) {
    const eta = ((Number(x.resolution_timestamp) - nowS) / 86400).toFixed(1);
    console.log(
      `  ${String(x.condition_id).slice(0, 14)}... res_in=${eta}d  q="${String(x.question_text ?? "").slice(0, 60)}"`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
