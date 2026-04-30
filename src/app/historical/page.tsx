// /historical — historical backtest results across multiple data windows.
//
// Companion to the live "Model leaderboard" home page. Where home shows
// real-time paper-trade performance, this shows how each strategy held up
// in various historical backtests as the R&D team has run them. As more
// historical data lands and gets re-run, new rows append to backtest_runs
// and appear here automatically.
//
// Sectioning:
//   - Per-run summary (each backtest run gets a card with a per-strategy
//     comparison table)
//   - Per-strategy trend (how does v4_broad_clean's mean ret/$ change as
//     the data window expands?)

import Link from "next/link";
import { db } from "@/lib/db";
import { backtestRuns, strategies, type BacktestRun, type Strategy } from "@/lib/db/schema";
import { desc, asc, eq } from "drizzle-orm";
import { fmtUsd, fmtUsdSigned, fmtCST, fmtPct } from "@/lib/format";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function fmtRet(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${Math.abs(v).toFixed(3)}`;
}

function colorRet(v: number | null): string {
  if (v == null) return "text-muted-foreground";
  if (v >= 1.0) return "text-emerald-400 font-semibold";
  if (v >= 0.5) return "text-emerald-500";
  if (v >= 0) return "text-foreground";
  return "text-red-400";
}

function colorP5(v: number | null): string {
  if (v == null) return "text-muted-foreground";
  if (v >= 15000) return "text-emerald-400 font-semibold";
  if (v >= 0) return "text-emerald-500";
  return "text-red-400";
}

export default async function HistoricalPage() {
  // Pull all backtest runs grouped by run_label.
  const runs = await db
    .select()
    .from(backtestRuns)
    .orderBy(desc(backtestRuns.runStartedAt), asc(backtestRuns.strategyId));
  const stratList: Strategy[] = await db
    .select()
    .from(strategies)
    .orderBy(asc(strategies.id));
  const stratById = new Map(stratList.map((s) => [s.id, s]));

  // Group by run_label, preserving order.
  const byLabel = new Map<string, BacktestRun[]>();
  for (const r of runs) {
    const arr = byLabel.get(r.runLabel) ?? [];
    arr.push(r);
    byLabel.set(r.runLabel, arr);
  }

  // Per-strategy trend: order by ingestion so we can see the metric drift
  // as the data window expands.
  const byStrategy = new Map<string, BacktestRun[]>();
  for (const r of runs) {
    const arr = byStrategy.get(r.strategyId) ?? [];
    arr.push(r);
    byStrategy.set(r.strategyId, arr);
  }

  return (
    <div className="space-y-8">
      <section className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Historical backtests</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Per-strategy backtest results across historical data windows. As the R&amp;D
            team extends the dataset back in time and re-runs the deployed deck,
            new rows appear here automatically.{" "}
            <Link href="/" className="underline hover:no-underline">
              ← Live leaderboard
            </Link>
          </p>
        </div>
        <div className="text-xs text-muted-foreground">{fmtCST(new Date())}</div>
      </section>

      {runs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/60 p-8 text-center text-sm text-muted-foreground">
          No backtest runs ingested yet. Trigger ingestion via{" "}
          <code className="font-mono text-xs">
            curl -H &quot;Authorization: Bearer $CRON_SECRET&quot; ... /api/admin/ingest-backtest?run_label=backtest_all_deployed
          </code>
        </div>
      ) : null}

      {/* Per-strategy summary across all runs */}
      {byStrategy.size > 0 ? (
        <section className="space-y-3">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Per-strategy trend
          </h2>
          <p className="text-xs text-muted-foreground">
            How did each strategy perform across each backtest run? More runs → more
            statistical confidence in the headline metric.
          </p>
          {Array.from(byStrategy.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([sid, rs]) => {
              const strat = stratById.get(sid);
              const status = strat?.status ?? "unknown";
              return (
                <div key={sid} className="border rounded-lg overflow-hidden">
                  <header className="bg-muted/30 px-4 py-2 flex items-baseline gap-3">
                    <h3 className="font-mono text-sm font-medium">{sid}</h3>
                    <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      {status}
                    </span>
                    <span className="text-xs text-muted-foreground ml-auto">
                      {rs.length} run{rs.length === 1 ? "" : "s"}
                    </span>
                  </header>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/20 text-muted-foreground">
                        <tr>
                          <th className="text-left px-3 py-1.5 font-medium">Run</th>
                          <th className="text-left px-3 py-1.5 font-medium">Span</th>
                          <th className="text-right px-3 py-1.5 font-medium">Bets</th>
                          <th className="text-right px-3 py-1.5 font-medium">Mean ret/$</th>
                          <th className="text-right px-3 py-1.5 font-medium">Total P&amp;L</th>
                          <th className="text-right px-3 py-1.5 font-medium">P5</th>
                          <th className="text-right px-3 py-1.5 font-medium">P_pos</th>
                          <th className="text-right px-3 py-1.5 font-medium">Top-1%</th>
                          <th className="text-right px-3 py-1.5 font-medium">Bets/mo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rs.map((r) => (
                          <tr key={r.id} className="border-t hover:bg-muted/10">
                            <td className="px-3 py-1.5 font-mono">{r.runLabel}</td>
                            <td className="px-3 py-1.5 text-muted-foreground">
                              {r.dataSpanStart || "—"} → {r.dataSpanEnd || "—"}
                            </td>
                            <td className="px-3 py-1.5 text-right font-mono">
                              {r.nBets ?? "—"}
                            </td>
                            <td className={`px-3 py-1.5 text-right font-mono ${colorRet(r.meanRetPerDollar)}`}>
                              {fmtRet(r.meanRetPerDollar)}
                            </td>
                            <td className="px-3 py-1.5 text-right font-mono">
                              {r.totalPnl == null ? "—" : fmtUsdSigned(r.totalPnl)}
                            </td>
                            <td className={`px-3 py-1.5 text-right font-mono ${colorP5(r.p5)}`}>
                              {r.p5 == null ? "—" : fmtUsdSigned(r.p5)}
                            </td>
                            <td className="px-3 py-1.5 text-right font-mono">
                              {r.pPos == null ? "—" : fmtPct(r.pPos)}
                            </td>
                            <td className="px-3 py-1.5 text-right font-mono">
                              {r.top1Conc == null ? "—" : `${(r.top1Conc * 100).toFixed(1)}%`}
                            </td>
                            <td className="px-3 py-1.5 text-right font-mono">
                              {r.betsPerMonth == null ? "—" : r.betsPerMonth.toFixed(1)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
        </section>
      ) : null}

      {/* Per-run cards */}
      {byLabel.size > 0 ? (
        <section className="space-y-3">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            By run
          </h2>
          {Array.from(byLabel.entries()).map(([label, items]) => {
            const desc = items[0]?.runDescription ?? null;
            const ranAt = items[0]?.runStartedAt ?? null;
            const bankroll = items[0]?.bankroll ?? 5000;
            const stake = items[0]?.stake ?? 50;
            return (
              <div key={label} className="border rounded-lg overflow-hidden">
                <header className="bg-muted/30 px-4 py-3 space-y-1">
                  <div className="flex items-baseline gap-3">
                    <h3 className="font-mono text-sm font-semibold">{label}</h3>
                    <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      {fmtUsd(bankroll)} / {fmtUsd(stake)} stake
                    </span>
                    <span className="text-xs text-muted-foreground ml-auto">
                      {ranAt ? fmtCST(ranAt) : "—"}
                    </span>
                  </div>
                  {desc ? (
                    <p className="text-xs text-muted-foreground leading-relaxed max-w-3xl">
                      {desc}
                    </p>
                  ) : null}
                </header>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/20 text-muted-foreground">
                      <tr>
                        <th className="text-left px-3 py-1.5 font-medium">Strategy</th>
                        <th className="text-right px-3 py-1.5 font-medium">Bets</th>
                        <th className="text-right px-3 py-1.5 font-medium">Mean ret/$</th>
                        <th className="text-right px-3 py-1.5 font-medium">Total</th>
                        <th className="text-right px-3 py-1.5 font-medium">P5</th>
                        <th className="text-right px-3 py-1.5 font-medium">P_pos</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items
                        .sort((a, b) => (b.totalPnl ?? 0) - (a.totalPnl ?? 0))
                        .map((r) => {
                          const sActive = stratById.get(r.strategyId)?.status === "active";
                          return (
                            <tr key={r.id} className="border-t">
                              <td className="px-3 py-1.5 font-mono">
                                {r.strategyId}
                                {!sActive ? (
                                  <span className="ml-2 text-[10px] uppercase text-zinc-500">retired</span>
                                ) : null}
                              </td>
                              <td className="px-3 py-1.5 text-right font-mono">{r.nBets ?? "—"}</td>
                              <td className={`px-3 py-1.5 text-right font-mono ${colorRet(r.meanRetPerDollar)}`}>
                                {fmtRet(r.meanRetPerDollar)}
                              </td>
                              <td className="px-3 py-1.5 text-right font-mono">
                                {r.totalPnl == null ? "—" : fmtUsdSigned(r.totalPnl)}
                              </td>
                              <td className={`px-3 py-1.5 text-right font-mono ${colorP5(r.p5)}`}>
                                {r.p5 == null ? "—" : fmtUsdSigned(r.p5)}
                              </td>
                              <td className="px-3 py-1.5 text-right font-mono">
                                {r.pPos == null ? "—" : fmtPct(r.pPos)}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </section>
      ) : null}
    </div>
  );
}
