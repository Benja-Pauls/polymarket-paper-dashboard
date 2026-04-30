/**
 * Test: how many markets does Gamma's paginated /markets?active=true&closed=false
 * actually return? And how many of OUR NULL-res-ts cids appear in that list?
 */
import { neon } from "@neondatabase/serverless";

const BASE = "https://gamma-api.polymarket.com";
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

  // Pull all NULL-res-ts tradeable_* cids from DB.
  const nullRows = await sql`
    SELECT condition_id, category
    FROM markets
    WHERE category = ANY(${TRADEABLE_CATS})
      AND resolution_timestamp IS NULL
  `;
  const nullSet = new Set<string>(
    (nullRows as Array<Record<string, unknown>>).map((r) => String(r.condition_id).toLowerCase()),
  );
  console.log(`DB has ${nullSet.size} NULL-res-ts tradeable_* cids.`);

  // Page through Gamma to get up to N markets with no end-date cap.
  const LIMIT = 500;
  const TARGET = 20000;
  let offset = 0;
  let totalSeen = 0;
  let totalActive = 0;
  let totalClosed = 0;
  let totalArchived = 0;
  let totalFromOurNullSet = 0;
  const matchedFromNull: Array<{ cid: string; endDate: string | null; closed: boolean; archived: boolean; active: boolean; daysOut: number | null }> = [];
  const sampleEndDates: number[] = []; // days from now

  while (totalSeen < TARGET) {
    const url = `${BASE}/markets?active=true&closed=false&limit=${LIMIT}&offset=${offset}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error(`Gamma ${resp.status} at offset ${offset}`);
      break;
    }
    const data = (await resp.json()) as Record<string, unknown>[];
    if (!Array.isArray(data) || data.length === 0) break;
    for (const r of data) {
      totalSeen++;
      const cid = String(r.conditionId ?? "").toLowerCase();
      if (!cid) continue;
      const active = r.active === true;
      const closed = r.closed === true;
      const archived = r.archived === true;
      if (active) totalActive++;
      if (closed) totalClosed++;
      if (archived) totalArchived++;
      const endDate = typeof r.endDate === "string" ? r.endDate : null;
      const ts = endDate ? Math.floor(Date.parse(endDate) / 1000) : null;
      const daysOut = ts != null ? (ts - nowS) / 86400 : null;
      if (daysOut != null) sampleEndDates.push(daysOut);
      if (nullSet.has(cid)) {
        totalFromOurNullSet++;
        matchedFromNull.push({ cid, endDate, closed, archived, active, daysOut });
      }
    }
    offset += data.length;
    if (data.length < LIMIT) break;
  }

  console.log(`\nGamma /markets?active=true&closed=false (no cap, up to ${TARGET}):`);
  console.log(`  Seen:        ${totalSeen}`);
  console.log(`  active=true: ${totalActive}`);
  console.log(`  closed=true: ${totalClosed}`);
  console.log(`  archived=true: ${totalArchived}`);
  console.log(`  matched from our NULL-set: ${totalFromOurNullSet} of ${nullSet.size}`);

  // Histogram of endDate days-out
  const buckets = { past: 0, lt30d: 0, lt60d: 0, lt90d: 0, lt180d: 0, lt365d: 0, gt365d: 0, noend: 0 };
  let noEnd = 0;
  for (const d of sampleEndDates) {
    if (d < 0) buckets.past++;
    else if (d < 30) buckets.lt30d++;
    else if (d < 60) buckets.lt60d++;
    else if (d < 90) buckets.lt90d++;
    else if (d < 180) buckets.lt180d++;
    else if (d < 365) buckets.lt365d++;
    else buckets.gt365d++;
  }
  noEnd = totalSeen - sampleEndDates.length;
  console.log(`\nendDate distribution across all ${totalSeen} seen:`);
  for (const [k, v] of Object.entries(buckets)) console.log(`  ${k.padEnd(8)} ${v}`);
  console.log(`  no_end   ${noEnd}`);

  // Sample 10 of the markets that were in our null-set
  if (matchedFromNull.length > 0) {
    console.log(`\nSample 10 matched markets:`);
    for (const m of matchedFromNull.slice(0, 10)) {
      const days = m.daysOut == null ? "(null)" : m.daysOut.toFixed(1) + "d";
      console.log(
        `  ${m.cid.slice(0, 14)}... end=${m.endDate ?? "(null)"} (${days}) closed=${m.closed} active=${m.active} archived=${m.archived}`,
      );
    }
  }

  // What about the cids we DIDN'T match?
  const unmatched = Array.from(nullSet).filter(
    (c) => !matchedFromNull.some((m) => m.cid === c),
  );
  console.log(`\nUnmatched cids: ${unmatched.length}`);
  if (unmatched.length > 0) {
    console.log("  Sample 5 unmatched (these are likely closed/archived on Gamma):");
    for (const cid of unmatched.slice(0, 5)) {
      console.log(`    ${cid.slice(0, 14)}...`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
