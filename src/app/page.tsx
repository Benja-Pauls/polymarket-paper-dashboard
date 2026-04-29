import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { listStrategies, getStrategySummary } from "@/lib/queries";
import type { Strategy } from "@/lib/db/schema";
import { fmtUsd, fmtPct, fmtUsdSigned } from "@/lib/format";
import { Sparkline } from "@/components/sparkline";
import { Separator } from "@/components/ui/separator";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function HomePage() {
  let strategies: Strategy[] = [];
  let dbError: string | null = null;
  try {
    strategies = await listStrategies();
  } catch (e) {
    dbError = (e as Error).message;
  }

  const summaries = await Promise.all(
    strategies.map(async (s) => {
      try {
        return await getStrategySummary(s);
      } catch {
        return null;
      }
    }),
  );

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-3xl font-semibold tracking-tight">Model leaderboard</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Paper-money trading strategies for Polymarket prediction markets. The cron polls
          Goldsky on schedule for new on-chain trades and applies each strategy&apos;s filter
          to virtual capital. <span className="font-medium text-foreground">No real money is ever placed.</span>
        </p>
      </section>

      {dbError ? (
        <Card className="border-destructive/30">
          <CardHeader>
            <CardTitle className="text-destructive">Database not connected</CardTitle>
            <CardDescription className="text-muted-foreground">{dbError}</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <p>Provision a Neon Postgres database from the Vercel Marketplace and pull env vars with <code className="font-mono">vercel env pull .env.local</code>.</p>
          </CardContent>
        </Card>
      ) : strategies.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No strategies seeded yet</CardTitle>
            <CardDescription>
              Run <code className="font-mono">pnpm seed</code> to insert the strategies
              defined in <code className="font-mono">src/lib/strategy.ts</code>.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {summaries.filter((x): x is NonNullable<typeof x> => x != null).map((sum) => {
            const pnl = sum.cumulativePnl;
            const pnlClass = pnl > 0 ? "text-emerald-400" : pnl < 0 ? "text-red-400" : "text-muted-foreground";
            const status = sum.strategy.status;
            return (
              <Link href={`/models/${sum.strategy.id}`} key={sum.strategy.id} className="group">
                <Card className="h-full border-border/70 bg-card/40 transition-colors group-hover:border-foreground/30 group-hover:bg-card/70">
                  <CardHeader>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <CardTitle className="font-mono text-base">{sum.strategy.name}</CardTitle>
                        <CardDescription className="line-clamp-2 mt-1 text-xs">
                          {sum.strategy.description ?? ""}
                        </CardDescription>
                      </div>
                      <Badge
                        variant={status === "active" ? "default" : status === "halted" ? "destructive" : "secondary"}
                        className="capitalize"
                      >
                        {status}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex items-baseline justify-between">
                      <div>
                        <p className="text-xs uppercase tracking-wider text-muted-foreground">Cumulative P&L</p>
                        <p className={`text-2xl font-semibold ${pnlClass}`}>
                          {fmtUsdSigned(sum.cumulativePnl)}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs uppercase tracking-wider text-muted-foreground">Bankroll</p>
                        <p className="font-mono text-sm">
                          {fmtUsd(sum.cashCurrent + sum.totalOpenStake)} / {fmtUsd(Number(sum.strategy.startingBankroll))}
                        </p>
                      </div>
                    </div>

                    {sum.sparkline.length > 1 ? (
                      <div className="h-12">
                        <Sparkline
                          data={sum.sparkline.map((p) => ({ x: p.date, y: p.cumulativePnl }))}
                          positiveColor="oklch(0.78 0.16 156)"
                          negativeColor="oklch(0.65 0.22 22)"
                        />
                      </div>
                    ) : (
                      <div className="flex h-12 items-center justify-center rounded-md border border-dashed border-border/60 text-[11px] text-muted-foreground">
                        Awaiting first daily snapshot
                      </div>
                    )}

                    <Separator className="bg-border/60" />

                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <Stat label="Bets" value={sum.nBetsTotal.toLocaleString()} />
                      <Stat label="Open" value={sum.nOpen.toLocaleString()} />
                      <Stat
                        label="Hit rate"
                        value={sum.hitRate == null ? "—" : fmtPct(sum.hitRate)}
                      />
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="font-mono text-sm">{value}</p>
    </div>
  );
}
