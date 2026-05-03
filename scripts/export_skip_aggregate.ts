// Pre-cleanup export: capture aggregate skip-decision patterns from the
// signals table to a local CSV before we drop the 537K bulk rows. The
// aggregate (count by strategy × reason × day) is what's actually useful
// for any future "what reasons fire how often per strategy" question;
// individual rows are derivable from the trade history at any time.
//
// Output: data/exports/skip_aggregate_YYYYMMDD.csv
//
// Run: pnpm tsx --env-file=.env.local scripts/export_skip_aggregate.ts

import { neon } from "@neondatabase/serverless";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const sql = neon(dbUrl);

  // Aggregate skip rows by (strategy, reason-prefix, day). The reason field
  // can have variable suffixes like "category=not_tradeable_weather not in
  // strategy whitelist" — we keep the full reason but the GROUP BY collapses
  // identical strings, which captures the pattern.
  console.log(`[export] querying aggregate counts ...`);
  const t0 = Date.now();
  const rows = (await sql`
    SELECT
      strategy_id,
      reason,
      to_char(date_trunc('day', to_timestamp(raw_ts)), 'YYYY-MM-DD') as day,
      count(*)::int as n,
      min(raw_ts) as first_seen_ts,
      max(raw_ts) as last_seen_ts
    FROM signals
    WHERE decision = 'skip'
    GROUP BY strategy_id, reason, day
    ORDER BY strategy_id, n DESC
  `) as Array<{
    strategy_id: string;
    reason: string;
    day: string;
    n: number;
    first_seen_ts: number;
    last_seen_ts: number;
  }>;
  console.log(`[export] got ${rows.length} aggregate rows in ${Date.now() - t0}ms`);

  // Total / by-strategy summary so we know what's in the file
  const byStrategy = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    byStrategy.set(r.strategy_id, (byStrategy.get(r.strategy_id) ?? 0) + r.n);
    total += r.n;
  }
  console.log(`\nTotal skip signals captured: ${total}`);
  console.log(`Distinct strategies:         ${byStrategy.size}`);
  console.log(`Distinct (strategy, reason, day) buckets: ${rows.length}`);
  console.log(`\nBy strategy:`);
  for (const [s, n] of [...byStrategy.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(35)} ${n.toString().padStart(8)} skips`);
  }

  // Write CSV
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const path = `data/exports/skip_aggregate_${today}.csv`;
  mkdirSync(dirname(path), { recursive: true });

  // Quote any fields with commas or quotes per RFC 4180
  const csvField = (v: unknown): string => {
    const s = String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const header = "strategy_id,reason,day,n,first_seen_ts,last_seen_ts\n";
  const body = rows
    .map(
      (r) =>
        [
          csvField(r.strategy_id),
          csvField(r.reason),
          csvField(r.day),
          csvField(r.n),
          csvField(r.first_seen_ts),
          csvField(r.last_seen_ts),
        ].join(","),
    )
    .join("\n");
  writeFileSync(path, header + body + "\n", "utf8");
  console.log(`\n✅ Wrote ${rows.length} aggregate rows → ${path}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
