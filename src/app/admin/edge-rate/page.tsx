// Admin page: hourly edge-eligible trade rate for the last 24h.
//
// Why: we need to see how many trades per hour are landing on tradeable_*
// markets with future resolution and price in [0.10, 0.40) — i.e. the
// edge-eligible cone. Without this, we can't tune filters or know whether
// "no bets in 4h" is a strategy issue or a flow issue.
//
// Source of truth: the `signals` table, restricted to strategy_id =
// 'baseline_v1'. baseline_v1 has the loosest filter (ep [0.10, 0.40), no
// volume cap, all tradeable categories) so its `signals` row count per hour
// is a clean lower bound on "trades the poll cron observed and tried to act
// on per hour" — every trade the cron sees is evaluated by every active
// strategy, and baseline writes a row for ALL of them (bet OR skip).
//
// The four columns:
//   1. trades            — every signals row for baseline_v1 in the hour.
//   2. tradeable         — those whose joined market.category starts with
//                          'tradeable_'.
//   3. edge_eligible     — tradeable + market.resolution_timestamp in
//                          (now, now+90d) + raw_price in [0.10, 0.40).
//   4. bets_placed       — DISTINCT bet decisions across ALL active
//                          strategies in the hour (so we count the cohort,
//                          not 8x duplicate strategy bets).
//
// All counts are server-rendered (no client JS). Refresh by reloading.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type HourRow = {
  hour: string; // ISO timestamp (start of hour, UTC)
  trades: number;
  tradeable: number;
  edge_eligible: number;
  bets_placed: number;
};

async function loadHourly(): Promise<HourRow[]> {
  const nowS = Math.floor(Date.now() / 1000);
  const sinceS = nowS - 24 * 3600;
  const horizonS = nowS + 90 * 86400;

  // We compute the edge-eligible flag per signals row inside SQL (cheaper
  // than streaming everything into TS). Then aggregate by hour bucket.
  //
  // Notes:
  //  - We use baseline_v1 because it has the loosest filter set and writes a
  //    skip row for every trade the cron observed. So COUNT(*) for that
  //    strategy = "trades observed by cron" within the window.
  //  - bets_placed is from ALL active strategies, but DISTINCT
  //    (raw_trade_id, market_cid) so we don't 8x-count cohort bets. (raw_trade_id
  //    is unique per on-chain trade.)
  const rows = await db.execute(sql<{
    hour: string;
    trades: number;
    tradeable: number;
    edge_eligible: number;
    bets_placed: number;
  }>`
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
  `);
  // drizzle's neon-http .execute returns a NeonHttpQueryResult with a `rows`
  // array. We typed the generic above for completeness.
  const arr =
    (rows as unknown as { rows?: unknown[] }).rows ??
    (rows as unknown as unknown[]);
  return Array.isArray(arr) ? (arr as HourRow[]) : [];
}

function fmtPct(num: number, denom: number): string {
  if (denom === 0) return "—";
  const pct = (num / denom) * 100;
  return `${pct.toFixed(1)}%`;
}

function fmtHour(iso: string): string {
  // "2026-04-29T14:00:00Z" → "Apr 29 14:00 UTC"
  const d = new Date(iso);
  const mon = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const day = d.getUTCDate();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return `${mon} ${day} ${hh}:00 UTC`;
}

export default async function EdgeRatePage() {
  let rows: HourRow[] = [];
  let dbError: string | null = null;
  try {
    rows = await loadHourly();
  } catch (e) {
    dbError = (e as Error).message;
  }

  // Totals across the 24h window for a footer summary.
  const totals = rows.reduce(
    (acc, r) => ({
      trades: acc.trades + r.trades,
      tradeable: acc.tradeable + r.tradeable,
      edge_eligible: acc.edge_eligible + r.edge_eligible,
      bets_placed: acc.bets_placed + r.bets_placed,
    }),
    { trades: 0, tradeable: 0, edge_eligible: 0, bets_placed: 0 },
  );

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-3xl font-semibold tracking-tight">Edge-eligible trade rate</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Hourly counts for the last 24h. <span className="font-mono">trades</span> = baseline_v1 signals
          (every trade the poll cron evaluated). <span className="font-mono">tradeable</span> = those
          whose market is classified <span className="font-mono">tradeable_*</span>.{" "}
          <span className="font-mono">edge_eligible</span> = tradeable +{" "}
          future res &lt; 90d + raw price ∈ [0.10, 0.40).{" "}
          <span className="font-mono">bets_placed</span> = distinct (raw_trade_id, market_cid)
          bet decisions across all active strategies.
        </p>
      </section>

      {dbError ? (
        <Card className="border-destructive/30">
          <CardHeader>
            <CardTitle className="text-destructive">Query failed</CardTitle>
            <CardDescription className="text-muted-foreground">{dbError}</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Last 24 hours (UTC)</CardTitle>
            <CardDescription>
              {totals.trades.toLocaleString()} trades · {totals.tradeable.toLocaleString()}{" "}
              tradeable · {totals.edge_eligible.toLocaleString()} edge-eligible ·{" "}
              {totals.bets_placed.toLocaleString()} bets ·{" "}
              conversion (bets / edge-eligible) ={" "}
              <span className="font-mono">{fmtPct(totals.bets_placed, totals.edge_eligible)}</span>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>hour</TableHead>
                  <TableHead className="text-right">trades</TableHead>
                  <TableHead className="text-right">tradeable</TableHead>
                  <TableHead className="text-right">edge-eligible</TableHead>
                  <TableHead className="text-right">bets-placed</TableHead>
                  <TableHead className="text-right">conv (bets/elig)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      No data in the last 24h.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((r) => {
                    const dim = r.trades === 0;
                    return (
                      <TableRow key={r.hour} className={dim ? "opacity-50" : undefined}>
                        <TableCell className="font-mono text-xs">{fmtHour(r.hour)}</TableCell>
                        <TableCell className="text-right font-mono">{r.trades.toLocaleString()}</TableCell>
                        <TableCell className="text-right font-mono">{r.tradeable.toLocaleString()}</TableCell>
                        <TableCell className="text-right font-mono">{r.edge_eligible.toLocaleString()}</TableCell>
                        <TableCell className="text-right font-mono">{r.bets_placed.toLocaleString()}</TableCell>
                        <TableCell className="text-right font-mono">
                          {fmtPct(r.bets_placed, r.edge_eligible)}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
