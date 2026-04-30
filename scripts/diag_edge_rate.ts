/**
 * Quick test: run the same SQL the /admin/edge-rate page runs and print rows.
 * Sanity-check before deploying.
 */
import { neon } from "@neondatabase/serverless";

async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const sql = neon(dbUrl);

  const nowS = Math.floor(Date.now() / 1000);
  const sinceS = nowS - 24 * 3600;
  const horizonS = nowS + 90 * 86400;

  const rows = await sql`
    with hours as (
      select generate_series(
        date_trunc('hour', to_timestamp(${sinceS}::bigint)),
        date_trunc('hour', to_timestamp(${nowS}::bigint)),
        interval '1 hour'
      ) as hour
    ),
    base as (
      select
        date_trunc('hour', to_timestamp(s.raw_ts)) as hour,
        s.raw_trade_id,
        s.market_cid,
        s.raw_price,
        m.category,
        m.resolution_timestamp
      from signals s
      left join markets m on m.condition_id = s.market_cid
      where s.strategy_id = 'baseline_v1'
        and s.raw_ts >= ${sinceS}
        and s.raw_ts < ${nowS}
    ),
    base_agg as (
      select
        hour,
        count(*)::int as trades,
        count(*) filter (where category like 'tradeable_%')::int as tradeable,
        count(*) filter (
          where category like 'tradeable_%'
            and resolution_timestamp is not null
            and resolution_timestamp > ${nowS}
            and resolution_timestamp < ${horizonS}
            and raw_price >= 0.10
            and raw_price < 0.40
        )::int as edge_eligible
      from base
      group by hour
    ),
    bets_agg as (
      select
        date_trunc('hour', to_timestamp(s.raw_ts)) as hour,
        count(distinct (s.raw_trade_id || '|' || s.market_cid))::int as bets_placed
      from signals s
      where s.decision = 'bet'
        and s.raw_ts >= ${sinceS}
        and s.raw_ts < ${nowS}
      group by hour
    )
    select
      to_char(h.hour at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:00"Z"') as hour,
      coalesce(b.trades, 0)::int as trades,
      coalesce(b.tradeable, 0)::int as tradeable,
      coalesce(b.edge_eligible, 0)::int as edge_eligible,
      coalesce(bp.bets_placed, 0)::int as bets_placed
    from hours h
    left join base_agg b on b.hour = h.hour
    left join bets_agg bp on bp.hour = h.hour
    order by h.hour desc
  `;

  console.log("hour                       trades  tradeable  edge_elig  bets  conv");
  console.log("─".repeat(75));
  let totalTrades = 0,
    totalTradeable = 0,
    totalEdge = 0,
    totalBets = 0;
  for (const r of rows) {
    const t = Number(r.trades);
    const tr = Number(r.tradeable);
    const e = Number(r.edge_eligible);
    const b = Number(r.bets_placed);
    totalTrades += t;
    totalTradeable += tr;
    totalEdge += e;
    totalBets += b;
    const conv = e > 0 ? `${((b / e) * 100).toFixed(1)}%` : "—";
    console.log(
      `${String(r.hour).padEnd(25)} ${String(t).padStart(6)}  ${String(tr).padStart(8)}  ${String(e).padStart(8)}  ${String(b).padStart(4)}  ${String(conv).padStart(5)}`,
    );
  }
  console.log("─".repeat(75));
  console.log(
    `TOTAL                     ${String(totalTrades).padStart(6)}  ${String(totalTradeable).padStart(8)}  ${String(totalEdge).padStart(8)}  ${String(totalBets).padStart(4)}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
