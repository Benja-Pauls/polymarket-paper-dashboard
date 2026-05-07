// One-shot backfill: run the new resolution+settlement pipeline against
// the current DB state to settle all overdue/resolved positions that were
// stuck due to the pre-2026-05-07 settlement bug.
//
// Uses the EXACT SAME library code as the production refresh-position-prices
// cron (src/lib/settlement). Whatever this script does, the cron will
// continue to do every 5 minutes going forward.
//
// Run:
//   pnpm tsx --env-file=.env.local scripts/backfill_settlements.ts            # dry preview
//   pnpm tsx --env-file=.env.local scripts/backfill_settlements.ts --execute  # actually settle

import { neon } from "@neondatabase/serverless";
import { refreshAndSettle } from "@/lib/settlement";

const EXECUTE = process.argv.includes("--execute");

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  // ── PRE-FLIGHT: snapshot the state we're about to mutate ─────────────
  const preStrats = (await sql`
    SELECT id, current_cash, starting_bankroll
    FROM strategies
    ORDER BY id
  `) as Array<{ id: string; current_cash: number; starting_bankroll: number }>;

  const preOpen = (await sql`
    SELECT count(*)::int AS n FROM positions WHERE settled_ts IS NULL
  `) as Array<{ n: number }>;
  const preSettled = (await sql`
    SELECT count(*)::int AS n FROM positions WHERE settled_ts IS NOT NULL
  `) as Array<{ n: number }>;
  const preResolved = (await sql`
    SELECT count(*)::int AS n FROM markets WHERE resolved = 1
  `) as Array<{ n: number }>;

  console.log(`\n${EXECUTE ? "===== EXECUTE MODE =====" : "===== DRY RUN (use --execute to apply) ====="}\n`);
  console.log(`Pre-flight snapshot:`);
  console.log(`  positions open:           ${preOpen[0].n}`);
  console.log(`  positions already settled: ${preSettled[0].n}`);
  console.log(`  markets resolved=1:       ${preResolved[0].n}`);
  console.log(`  strategies:               ${preStrats.length}`);
  console.log(`\nPer-strategy cash before run:`);
  for (const s of preStrats) {
    console.log(
      `  ${s.id.padEnd(35)} cash=$${Number(s.current_cash).toFixed(2).padStart(8)}  bankroll=$${Number(s.starting_bankroll).toFixed(0)}`,
    );
  }

  if (!EXECUTE) {
    console.log(
      `\nDry-run only — no DB changes. Re-run with --execute to apply settlement.\n`,
    );
    console.log(
      `When --execute is passed, the script calls refreshAndSettle() from src/lib/settlement,`,
    );
    console.log(
      `which is the EXACT SAME code the refresh-position-prices cron runs every 5 min.`,
    );
    console.log(
      `It will: (1) refresh prices for every open-position market via CLOB,`,
    );
    console.log(
      `(2) detect any markets where CLOB shows closed=true with a winner,`,
    );
    console.log(
      `(3) mark them resolved in our DB, (4) settle every open position on those markets`,
    );
    console.log(
      `using settlePosition() math (payout = stake/entry_price for winners, 0 for losers,`,
    );
    console.log(
      `minus per-strategy slippage), and (5) credit each strategy's current_cash by sum`,
    );
    console.log(`of its position payouts. Atomic and idempotent.`);
    return;
  }

  // ── EXECUTE ───────────────────────────────────────────────────────────
  console.log(`\nRunning refreshAndSettle()...\n`);
  const t0 = Date.now();
  const summary = await refreshAndSettle();
  const elapsedMs = Date.now() - t0;
  console.log(`...done in ${elapsedMs}ms\n`);

  // ── REPORT ───────────────────────────────────────────────────────────
  console.log(`===== SUMMARY =====`);
  console.log(`  Open-position cids checked:  ${summary.open_position_cids}`);
  console.log(`  CLOB returned data for:      ${summary.clob_returned}`);
  console.log(`  Prices updated:              ${summary.prices_updated}`);
  console.log(`  Prices missing:              ${summary.prices_missing}`);
  console.log(`  Markets newly RESOLVED:      ${summary.markets_newly_resolved}`);
  console.log(`  Positions SETTLED:           ${summary.positions_settled}`);
  console.log(`  Total cash credited:         $${summary.cash_credited_total_usd.toFixed(2)}`);

  console.log(`\n===== Cash credit by strategy =====`);
  for (const [stratId, delta] of Object.entries(summary.cash_credited_by_strategy).sort(
    ([, a], [, b]) => b - a,
  )) {
    console.log(`  ${stratId.padEnd(35)} +$${delta.toFixed(2).padStart(8)}`);
  }

  if (summary.settlements.length > 0) {
    console.log(
      `\n===== Position-level settlements (first ${Math.min(summary.settlements.length, 20)}) =====`,
    );
    console.log(
      `${"strategy".padEnd(33)} ${"side".padStart(4)} ${"entry".padStart(6)} ${"stake".padStart(6)} ${"won".padStart(4)} ${"payout".padStart(8)} ${"return".padStart(8)}`,
    );
    for (const s of summary.settlements.slice(0, 20)) {
      const side = s.bet_outcome === 0 ? "YES" : "NO";
      console.log(
        `${s.strategy_id.padEnd(33)} ${side.padStart(4)} $${s.entry_price.toFixed(3)} $${s.stake.toFixed(0).padStart(5)} ${String(s.won).padStart(4)} $${s.payout.toFixed(2).padStart(7)} ${s.realized_return.toFixed(2).padStart(8)}`,
      );
    }
    if (summary.settlements.length > 20) {
      console.log(`  ...and ${summary.settlements.length - 20} more (truncated for display)`);
    }
  }

  // ── POST-FLIGHT: verify per-strategy cash math ───────────────────────
  const postStrats = (await sql`
    SELECT id, current_cash FROM strategies ORDER BY id
  `) as Array<{ id: string; current_cash: number }>;

  console.log(`\n===== Per-strategy cash CHANGE =====`);
  console.log(
    `${"strategy".padEnd(35)} ${"before".padStart(10)} ${"after".padStart(10)} ${"delta".padStart(10)} ${"reported".padStart(10)} ${"match".padStart(7)}`,
  );
  let allMatch = true;
  for (const s of postStrats) {
    const pre = preStrats.find((p) => p.id === s.id);
    if (!pre) continue;
    const before = Number(pre.current_cash);
    const after = Number(s.current_cash);
    const actualDelta = after - before;
    const reportedDelta = summary.cash_credited_by_strategy[s.id] ?? 0;
    // Floats have rounding noise — compare to a small epsilon.
    const match = Math.abs(actualDelta - reportedDelta) < 0.001;
    if (!match) allMatch = false;
    console.log(
      `${s.id.padEnd(35)} $${before.toFixed(2).padStart(9)} $${after.toFixed(2).padStart(9)} $${actualDelta.toFixed(2).padStart(9)} $${reportedDelta.toFixed(2).padStart(9)} ${match ? "✅" : "❌"}`,
    );
  }
  if (allMatch) {
    console.log(`\n✅ Per-strategy cash deltas reconcile EXACTLY with reported settlement payouts.`);
  } else {
    console.log(
      `\n❌ MISMATCH between actual cash change and reported settlement payouts. INVESTIGATE before trusting numbers.`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
