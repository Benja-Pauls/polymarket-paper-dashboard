import { neon } from "@neondatabase/serverless";
async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const sql = neon(dbUrl);

  console.log("\n=== Strategies: bankroll vs current cash ===");
  const r = await sql`
    SELECT id, status, starting_bankroll, current_cash, stake, last_poll_ts
    FROM strategies ORDER BY id
  `;
  for (const s of r) {
    console.log(`  ${String(s.id).padEnd(35)} bank=$${s.starting_bankroll}  cash=$${s.current_cash}  stake=$${s.stake}  status=${s.status}`);
  }

  // Per-strategy: bets placed + total stake + total payout (settled)
  console.log("\n=== Per-strategy: bets placed, stake out, payouts received ===");
  const r2 = await sql`
    SELECT
      p.strategy_id,
      COUNT(*)::int as n_bets,
      COALESCE(SUM(p.stake), 0)::float as total_stake,
      COUNT(*) FILTER (WHERE p.settled_ts IS NULL)::int as n_open,
      COUNT(*) FILTER (WHERE p.settled_ts IS NOT NULL)::int as n_settled,
      COALESCE(SUM(p.payout) FILTER (WHERE p.settled_ts IS NOT NULL), 0)::float as total_payout,
      COALESCE(SUM(p.stake) FILTER (WHERE p.settled_ts IS NULL), 0)::float as open_stake
    FROM positions p
    GROUP BY p.strategy_id ORDER BY p.strategy_id
  `;
  for (const x of r2) {
    console.log(`  ${String(x.strategy_id).padEnd(35)} bets=${x.n_bets} stake_out=$${x.total_stake} open=${x.n_open}($${x.open_stake}) settled=${x.n_settled} payouts=$${x.total_payout.toFixed(2)}`);
  }

  // Check: starting_bankroll + payouts - total_stake = current_cash + open_stake?
  // (cash + open_stake) should equal (bankroll + payouts - settled_stake)
  console.log("\n=== Sanity check: cash + open_stake vs bankroll + realized_pnl ===");
  for (const s of r) {
    const stats = r2.find(x => x.strategy_id === s.id);
    if (!stats) {
      console.log(`  ${s.id}: no positions, cash=$${s.current_cash} (vs bankroll $${s.starting_bankroll})`);
      continue;
    }
    const total_value_if_open_resolves_at_stake = Number(s.current_cash) + Number(stats.open_stake);
    const expected = Number(s.starting_bankroll) + Number(stats.total_payout) - (Number(stats.total_stake) - Number(stats.open_stake));
    console.log(`  ${String(s.id).padEnd(35)} cash+open=${total_value_if_open_resolves_at_stake.toFixed(2)} expected≈${expected.toFixed(2)} delta=${(total_value_if_open_resolves_at_stake-expected).toFixed(2)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
