/**
 * Diag: WHY are 590 of 830 tradeable_geopolitical markets NULL resolution_timestamp?
 *
 * Approach:
 *  1. Count NULL-resolution-timestamp markets by tradeable_* category.
 *  2. Sample 20 of them and query Gamma directly (per cid) to see what state
 *     they're in: open? closed? archived? endDate? not-found?
 *  3. Print a summary so we can decide on the right fix.
 *
 * Run: pnpm exec tsx --env-file=.env.local scripts/diag_resolution_gap.ts
 */
import { neon } from "@neondatabase/serverless";

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

const GAMMA_BASE = "https://gamma-api.polymarket.com";

type GammaState = {
  cid: string;
  found: boolean;
  active: boolean | null;
  closed: boolean | null;
  archived: boolean | null;
  endDate: string | null;
  question: string | null;
};

async function fetchGammaState(cid: string): Promise<GammaState> {
  const url = `${GAMMA_BASE}/markets?conditionIds=${encodeURIComponent(cid)}&limit=1`;
  try {
    const resp = await fetch(url, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!resp.ok) {
      return {
        cid,
        found: false,
        active: null,
        closed: null,
        archived: null,
        endDate: null,
        question: null,
      };
    }
    const data = (await resp.json()) as unknown;
    if (!Array.isArray(data) || data.length === 0) {
      return {
        cid,
        found: false,
        active: null,
        closed: null,
        archived: null,
        endDate: null,
        question: null,
      };
    }
    const r = data[0] as Record<string, unknown>;
    return {
      cid,
      found: true,
      active: r.active === true,
      closed: r.closed === true,
      archived: r.archived === true,
      endDate: typeof r.endDate === "string" ? r.endDate : null,
      question: typeof r.question === "string" ? r.question : null,
    };
  } catch (e) {
    return {
      cid,
      found: false,
      active: null,
      closed: null,
      archived: null,
      endDate: null,
      question: null,
    };
  }
}

async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const sql = neon(dbUrl);
  const now = Math.floor(Date.now() / 1000);

  console.log("=== NULL resolution_timestamp counts by tradeable category ===");
  const counts = await sql`
    SELECT
      coalesce(category, '(null)') as category,
      COUNT(*) FILTER (WHERE resolution_timestamp IS NULL)::int as n_null,
      COUNT(*) FILTER (WHERE resolution_timestamp IS NOT NULL AND resolution_timestamp > ${now})::int as n_future,
      COUNT(*) FILTER (WHERE resolution_timestamp IS NOT NULL AND resolution_timestamp <= ${now})::int as n_past,
      COUNT(*)::int as n_total
    FROM markets
    WHERE category = ANY(${TRADEABLE_CATS})
    GROUP BY category
    ORDER BY n_null DESC
  `;
  for (const x of counts) {
    console.log(
      `  ${String(x.category).padEnd(28)} null=${String(x.n_null).padStart(4)}  future=${String(x.n_future).padStart(4)}  past=${String(x.n_past).padStart(4)}  total=${String(x.n_total).padStart(4)}`,
    );
  }

  console.log("\n=== Sampling 20 NULL-res-ts tradeable_geopolitical cids ===");
  const sampleRows = await sql`
    SELECT condition_id, question_text, updated_at
    FROM markets
    WHERE category = 'tradeable_geopolitical' AND resolution_timestamp IS NULL
    ORDER BY random()
    LIMIT 20
  `;
  console.log(`  picked ${sampleRows.length} samples`);

  console.log("\n=== Gamma direct lookups (per cid) ===");
  const gammaResults: GammaState[] = [];
  for (const r of sampleRows) {
    const cid = String(r.condition_id);
    const state = await fetchGammaState(cid);
    gammaResults.push(state);
    const tag = state.found
      ? `active=${state.active} closed=${state.closed} archived=${state.archived} end=${state.endDate ?? "(null)"}`
      : "NOT_FOUND_ON_GAMMA";
    console.log(
      `  ${cid.slice(0, 14)}... ${tag}  q="${String(r.question_text ?? "").slice(0, 60)}"`,
    );
  }

  // Summary
  console.log("\n=== Summary ===");
  const nFound = gammaResults.filter((r) => r.found).length;
  const nNotFound = gammaResults.filter((r) => !r.found).length;
  const nClosed = gammaResults.filter((r) => r.found && r.closed).length;
  const nActiveOpen = gammaResults.filter(
    (r) => r.found && r.active && !r.closed,
  ).length;
  const nInactive = gammaResults.filter(
    (r) => r.found && !r.active && !r.closed,
  ).length;
  const nArchived = gammaResults.filter((r) => r.found && r.archived).length;
  const nWithEnd = gammaResults.filter((r) => r.found && r.endDate).length;
  console.log(`  total sampled:        ${gammaResults.length}`);
  console.log(`  found on gamma:       ${nFound}`);
  console.log(`  not found on gamma:   ${nNotFound}`);
  console.log(`  found & closed:       ${nClosed}`);
  console.log(`  found & active+open:  ${nActiveOpen}`);
  console.log(`  found & inactive:     ${nInactive}`);
  console.log(`  found & archived:     ${nArchived}`);
  console.log(`  found WITH endDate:   ${nWithEnd}`);

  // Time-to-resolution distribution among sampled markets that DO have an endDate
  if (nWithEnd > 0) {
    console.log("\n=== endDate distribution (for the ones gamma returned with endDate) ===");
    const buckets = { past: 0, lt30d: 0, lt60d: 0, lt180d: 0, lt365d: 0, gt365d: 0 };
    for (const r of gammaResults) {
      if (!r.endDate) continue;
      const ts = Math.floor(Date.parse(r.endDate) / 1000);
      const dt = (ts - now) / 86400;
      if (dt < 0) buckets.past++;
      else if (dt < 30) buckets.lt30d++;
      else if (dt < 60) buckets.lt60d++;
      else if (dt < 180) buckets.lt180d++;
      else if (dt < 365) buckets.lt365d++;
      else buckets.gt365d++;
    }
    for (const [k, v] of Object.entries(buckets))
      console.log(`  ${k.padEnd(8)} ${v}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
