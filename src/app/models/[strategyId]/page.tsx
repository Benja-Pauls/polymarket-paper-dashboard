import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { BarStatusBadge, MethodologyTab } from "@/components/methodology-tab";
import { TripwirePanel } from "@/components/tripwire-panel";
import { WealthCurve } from "@/components/wealth-curve";
import {
  fmtDate,
  fmtPct,
  fmtPrice,
  fmtTs,
  fmtUsd,
  fmtUsdSigned,
  shortAddr,
  shortCid,
} from "@/lib/format";
import {
  getClosedPositions,
  getOpenPositions,
  getRecentSignals,
  getStrategy,
  getStrategyMethodology,
  getStrategySummary,
  getStrategyTripwires,
  getWealthCurve,
} from "@/lib/queries";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function StrategyDetailPage({
  params,
}: {
  params: Promise<{ strategyId: string }>;
}) {
  const { strategyId } = await params;
  const strategy = await getStrategy(strategyId);
  if (!strategy) notFound();

  const [summary, wealth, openPos, closedPos, recentSignals, tripwires, methodology] =
    await Promise.all([
      getStrategySummary(strategy),
      getWealthCurve(strategy.id),
      getOpenPositions(strategy.id, 200),
      getClosedPositions(strategy.id, 200),
      getRecentSignals(strategy.id, 50),
      getStrategyTripwires(strategy),
      getStrategyMethodology(strategy.id),
    ]);

  const params_ = (strategy.paramsJson as Record<string, unknown>) ?? {};

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Link href="/" className="hover:text-foreground">
            ← Leaderboard
          </Link>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <h1 className="font-mono text-2xl font-semibold tracking-tight">{strategy.name}</h1>
            <p className="max-w-3xl text-sm text-muted-foreground">{strategy.description}</p>
            <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              id: {strategy.id} · stake ${Number(strategy.stake).toFixed(0)} · bankroll $
              {Number(strategy.startingBankroll).toFixed(0)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {methodology && <BarStatusBadge status={methodology.barStatus} />}
            <Badge
              variant={strategy.status === "active" ? "default" : "secondary"}
              className="capitalize"
            >
              {strategy.status}
            </Badge>
          </div>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KPI
          label="Cumulative P&L"
          value={fmtUsdSigned(summary.cumulativePnl)}
          tone={summary.cumulativePnl > 0 ? "pos" : summary.cumulativePnl < 0 ? "neg" : "neutral"}
        />
        <KPI label="Realized P&L" value={fmtUsdSigned(summary.realizedPnl)} />
        <KPI
          label="Bankroll"
          value={fmtUsd(summary.cashCurrent + summary.totalOpenStake)}
          subtitle={`/ ${fmtUsd(Number(strategy.startingBankroll))}`}
        />
        <KPI
          label="Bets / hit rate"
          value={summary.nBetsTotal.toString()}
          subtitle={summary.hitRate == null ? "—" : `${fmtPct(summary.hitRate)} hit`}
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Wealth curve
        </h2>
        <Card className="border-border/60">
          <CardContent className="p-4">
            <WealthCurve data={wealth} />
          </CardContent>
        </Card>
      </section>

      <Tabs defaultValue="open">
        <TabsList>
          <TabsTrigger value="open">Open positions ({openPos.length})</TabsTrigger>
          <TabsTrigger value="signals">Recent signals ({recentSignals.length})</TabsTrigger>
          <TabsTrigger value="closed">Closed positions ({closedPos.length})</TabsTrigger>
          <TabsTrigger value="methodology">Methodology</TabsTrigger>
          <TabsTrigger value="params">Params</TabsTrigger>
          <TabsTrigger value="tripwires">Tripwires</TabsTrigger>
        </TabsList>

        <TabsContent value="open" className="mt-4">
          <Card className="border-border/60">
            <CardContent className="p-0">
              {openPos.length === 0 ? (
                <Empty
                  title="No open positions"
                  description="The cron will create positions as new tradeable trades come in from Goldsky."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Market</TableHead>
                      <TableHead>Side / outcome</TableHead>
                      <TableHead className="text-right">Entry price</TableHead>
                      <TableHead className="text-right">Stake</TableHead>
                      <TableHead>Entry</TableHead>
                      <TableHead>Resolution</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {openPos.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="max-w-[26ch]">
                          <Link
                            href={`/models/${strategy.id}/markets/${p.marketCid}`}
                            className="line-clamp-1 hover:underline"
                          >
                            {p.question ?? shortCid(p.marketCid)}
                          </Link>
                          <span className="text-[10px] font-mono text-muted-foreground">
                            {p.category ?? "?"} · {shortCid(p.marketCid, 4)}
                          </span>
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          BUY · outcome {p.betOutcome}
                        </TableCell>
                        <TableCell className="text-right font-mono">{fmtPrice(p.entryPrice)}</TableCell>
                        <TableCell className="text-right font-mono">{fmtUsd(Number(p.stake))}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {fmtTs(Number(p.entryTs))}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {fmtDate(p.plannedResolutionTs ?? p.resolutionTimestamp ?? null)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="signals" className="mt-4">
          <Card className="border-border/60">
            <CardContent className="p-0">
              {recentSignals.length === 0 ? (
                <Empty
                  title="No signals yet"
                  description="The first cron run will populate signals."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Market</TableHead>
                      <TableHead>Decision</TableHead>
                      <TableHead className="text-right">Entry price</TableHead>
                      <TableHead>Wallet</TableHead>
                      <TableHead>Reason</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recentSignals.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="text-xs text-muted-foreground">
                          {fmtTs(Number(s.rawTs))}
                        </TableCell>
                        <TableCell className="max-w-[28ch]">
                          <Link
                            href={`/models/${strategy.id}/markets/${s.marketCid}`}
                            className="line-clamp-1 hover:underline"
                          >
                            {s.question ?? shortCid(s.marketCid)}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Badge variant={s.decision === "bet" ? "default" : "secondary"}>
                            {s.decision}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {fmtPrice(s.entryPrice)}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{shortAddr(s.rawWallet)}</TableCell>
                        <TableCell className="max-w-[36ch] text-xs text-muted-foreground">
                          <span className="line-clamp-1">{s.reason}</span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="closed" className="mt-4">
          <Card className="border-border/60">
            <CardContent className="p-0">
              {closedPos.length === 0 ? (
                <Empty
                  title="No closed positions"
                  description="Positions settle when their underlying market resolves on-chain."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Market</TableHead>
                      <TableHead className="text-right">Entry</TableHead>
                      <TableHead className="text-right">Stake</TableHead>
                      <TableHead className="text-right">Payout</TableHead>
                      <TableHead className="text-right">Return</TableHead>
                      <TableHead>Result</TableHead>
                      <TableHead>Settled</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {closedPos.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="max-w-[26ch]">
                          <Link
                            href={`/models/${strategy.id}/markets/${p.marketCid}`}
                            className="line-clamp-1 hover:underline"
                          >
                            {p.question ?? shortCid(p.marketCid)}
                          </Link>
                        </TableCell>
                        <TableCell className="text-right font-mono">{fmtPrice(p.entryPrice)}</TableCell>
                        <TableCell className="text-right font-mono">{fmtUsd(Number(p.stake))}</TableCell>
                        <TableCell className="text-right font-mono">{fmtUsd(p.payout)}</TableCell>
                        <TableCell
                          className={`text-right font-mono ${
                            (p.realizedReturn ?? 0) > 0
                              ? "text-emerald-400"
                              : (p.realizedReturn ?? 0) < 0
                                ? "text-red-400"
                                : ""
                          }`}
                        >
                          {p.realizedReturnPct == null ? "—" : `${p.realizedReturnPct >= 0 ? "+" : ""}${p.realizedReturnPct.toFixed(1)}%`}
                        </TableCell>
                        <TableCell>
                          <Badge variant={p.won === 1 ? "default" : "destructive"}>
                            {p.won === 1 ? "won" : p.won === 0 ? "lost" : "—"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {fmtTs(p.settledTs ?? null)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="methodology" className="mt-4">
          {methodology ? (
            <MethodologyTab m={methodology} />
          ) : (
            <Card className="border-border/60">
              <CardHeader>
                <CardTitle className="text-base">No methodology recorded</CardTitle>
                <CardDescription>
                  Run <code className="font-mono">pnpm exec tsx --env-file=.env.local scripts/seed_methodology.ts</code> to
                  populate the methodology entry for this strategy.
                </CardDescription>
              </CardHeader>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="params" className="mt-4">
          <Card className="border-border/60">
            <CardHeader>
              <CardTitle className="text-base">Strategy parameters</CardTitle>
              <CardDescription>
                Filter applied to every Goldsky-observed trade. Edit these in
                <code className="ml-1 font-mono">src/lib/strategy.ts</code> and re-run
                <code className="ml-1 font-mono">pnpm seed</code>.
              </CardDescription>
            </CardHeader>
            <Separator />
            <CardContent className="pt-6">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {Object.entries(params_).map(([k, v]) => (
                  <ParamRow key={k} k={k} v={v} />
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tripwires" className="mt-4 space-y-4">
          <Card className="border-border/60">
            <CardHeader>
              <CardTitle className="text-base">Halt thresholds</CardTitle>
              <CardDescription>
                When a tripwire fires, the strategy stops placing new bets but keeps any open
                positions until they resolve. Adjust thresholds in <code className="font-mono">src/lib/strategy.ts</code>.
              </CardDescription>
            </CardHeader>
            <Separator />
            <CardContent className="pt-6">
              <TripwirePanel status={tripwires} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function KPI({
  label,
  value,
  subtitle,
  tone,
}: {
  label: string;
  value: string;
  subtitle?: string;
  tone?: "pos" | "neg" | "neutral";
}) {
  const toneClass =
    tone === "pos" ? "text-emerald-400" : tone === "neg" ? "text-red-400" : "";
  return (
    <Card className="border-border/60">
      <CardHeader className="pb-2">
        <CardDescription className="text-[11px] uppercase tracking-wider">
          {label}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-semibold ${toneClass}`}>{value}</div>
        {subtitle && (
          <div className="mt-0.5 text-[11px] text-muted-foreground">{subtitle}</div>
        )}
      </CardContent>
    </Card>
  );
}

function Empty({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-16 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-md text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

function ParamRow({ k, v }: { k: string; v: unknown }) {
  let display: string;
  if (Array.isArray(v)) {
    display = v.length === 0 ? "[]" : v.join(", ");
  } else if (v === null) {
    display = "null (no filter)";
  } else if (typeof v === "number") {
    display = String(v);
  } else {
    display = String(v);
  }
  return (
    <div className="flex items-baseline justify-between gap-3 rounded-md border border-border/40 bg-card/30 px-3 py-2">
      <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
        {k}
      </span>
      <span className="font-mono text-xs text-foreground break-all">{display}</span>
    </div>
  );
}
