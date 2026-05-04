import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  listStrategies,
  getStrategySummary,
  listStrategyBarStatuses,
  type StrategySummary,
} from "@/lib/queries";
import type { Strategy } from "@/lib/db/schema";
import { cronRuns } from "@/lib/db/schema";
import { fmtUsd, fmtPct, fmtUsdSigned, fmtAgo, fmtCountdown, nextCronFire, fmtCST } from "@/lib/format";
import { db } from "@/lib/db";
import { desc, eq, sql } from "drizzle-orm";
import { Sparkline } from "@/components/sparkline";
import { BarStatusBadge } from "@/components/methodology-tab";
import { Separator } from "@/components/ui/separator";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Cron schedules — kept in lockstep with vercel.ts. The home-page status widget
// uses these to render countdowns; the full /admin/crons page has descriptions.
//
// IMPORTANT: if you change a schedule in vercel.ts, mirror it here. Drift here
// silently shows the wrong "next firing" countdown — already happened once
// (sync-open-markets was bumped 6h→1h on 2026-04-29 in vercel.ts but this
// constant stayed at 6h until the 2026-05-03 audit caught it).
const HOME_CRONS = [
  { name: "poll", label: "Trade poll", schedule: "*/15 * * * *" },
  { name: "sync-open-markets", label: "Market sync", schedule: "0 * * * *" },
] as const;

export default async function HomePage() {
  const nowMs = Date.now();
  let strategies: Strategy[] = [];
  let dbError: string | null = null;
  try {
    strategies = await listStrategies();
  } catch (e) {
    dbError = (e as Error).message;
  }

  const [summaries, barStatuses, cronStatus, cronHealth1h] = await Promise.all([
    Promise.all(
      strategies.map(async (s) => {
        try {
          return await getStrategySummary(s);
        } catch {
          return null;
        }
      }),
    ),
    listStrategyBarStatuses().catch(() => ({}) as Record<string, string>),
    Promise.all(
      HOME_CRONS.map(async (c) => {
        try {
          const r = await db
            .select()
            .from(cronRuns)
            .where(eq(cronRuns.cronName, c.name))
            .orderBy(desc(cronRuns.startedAt))
            .limit(1);
          return { cron: c, last: r[0] ?? null };
        } catch {
          return { cron: c, last: null };
        }
      }),
    ),
    // Aggregate cron health over the last hour. Drives the top-of-page banner.
    // Empty/error → return zeros, banner falls back to neutral "no data".
    (async () => {
      try {
        const since = new Date(nowMs - 60 * 60 * 1000);
        const r = await db
          .select({
            ok: sql<number>`count(*) FILTER (WHERE status='ok')::int`,
            err: sql<number>`count(*) FILTER (WHERE status='error')::int`,
            total: sql<number>`count(*)::int`,
          })
          .from(cronRuns)
          .where(sql`started_at >= ${since}`);
        const row = r[0];
        return { ok: row?.ok ?? 0, err: row?.err ?? 0, total: row?.total ?? 0 };
      } catch {
        return { ok: 0, err: 0, total: 0 };
      }
    })(),
  ]);

  // Partition cards by status: active+halted ("live") render in the main grid;
  // retired ones get tucked into a collapsed details section. Retired strategies
  // have great halt_reason annotations that are worth keeping accessible (post-
  // mortem signal) but they shouldn't dominate the main view.
  const validSummaries = summaries.filter(
    (x): x is NonNullable<typeof x> => x != null,
  );
  const liveSummaries = validSummaries.filter(
    (s) => s.strategy.status !== "retired",
  );
  const retiredSummaries = validSummaries.filter(
    (s) => s.strategy.status === "retired",
  );

  return (
    <div className="space-y-8">
      {/* Top-of-page health banner. Reads aggregate cron firings over the last
          hour and renders green/amber/red. Same data the corner Cron-status
          card uses for individual crons; this is the one-line summary. */}
      <HealthBanner health={cronHealth1h} />

      <section className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Model leaderboard</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Paper-money trading strategies for Polymarket prediction markets. The cron polls
            Polymarket data-api on schedule for new on-chain trades and applies each strategy&apos;s
            filter to virtual capital. <span className="font-medium text-foreground">No real money is ever placed.</span>
          </p>
        </div>
        <Card className="min-w-[280px] border-border/70 bg-card/40">
          <CardContent className="p-4 space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-medium text-foreground">Cron status</span>
              <Link href="/admin/crons" className="text-muted-foreground hover:underline">
                details →
              </Link>
            </div>
            {cronStatus.map(({ cron, last }) => {
              const next = nextCronFire(cron.schedule, nowMs);
              const lastOk = last?.status === "ok";
              return (
                <div key={cron.name} className="space-y-0.5">
                  <div className="flex items-center justify-between font-mono">
                    <span className="text-muted-foreground">{cron.label}</span>
                    <span className={lastOk ? "text-emerald-500" : last ? "text-red-500" : "text-muted-foreground"}>
                      {last ? (lastOk ? "OK" : "ERR") : "—"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>
                      last: {last ? fmtAgo(last.startedAt, nowMs) : "never"}
                    </span>
                    <span>
                      next: {next ? fmtCountdown(next, nowMs) : "—"}
                    </span>
                  </div>
                </div>
              );
            })}
            <div className="text-[10px] text-muted-foreground pt-1 border-t border-border/40 mt-2">
              {fmtCST(new Date(nowMs))}
            </div>
          </CardContent>
        </Card>
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
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {liveSummaries.map((sum) => (
              <StrategyCard key={sum.strategy.id} sum={sum} barStatus={barStatuses[sum.strategy.id]} />
            ))}
          </div>

          {retiredSummaries.length > 0 ? (
            <details className="group rounded-lg border border-border/40 bg-muted/10">
              <summary className="cursor-pointer select-none px-4 py-3 text-sm hover:bg-muted/20 transition-colors">
                <span className="font-medium">Retired strategies</span>
                <span className="ml-2 text-muted-foreground">
                  ({retiredSummaries.length})
                </span>
                <span className="ml-2 text-xs text-muted-foreground">
                  — preserved for post-mortem; click to expand
                </span>
              </summary>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 px-4 py-4 border-t border-border/40">
                {retiredSummaries.map((sum) => (
                  <StrategyCard
                    key={sum.strategy.id}
                    sum={sum}
                    barStatus={barStatuses[sum.strategy.id]}
                    dimmed
                  />
                ))}
              </div>
            </details>
          ) : null}
        </>
      )}
    </div>
  );
}

function StrategyCard({
  sum,
  barStatus,
  dimmed = false,
}: {
  sum: StrategySummary;
  barStatus?: string;
  dimmed?: boolean;
}) {
  const pnl = sum.cumulativePnl;
  const pnlClass = pnl > 0 ? "text-emerald-400" : pnl < 0 ? "text-red-400" : "text-muted-foreground";
  const status = sum.strategy.status;
  const haltReason = sum.strategy.haltReason;
  return (
    <Link href={`/models/${sum.strategy.id}`} className="group">
      <Card
        className={`h-full border-border/70 bg-card/40 transition-colors group-hover:border-foreground/30 group-hover:bg-card/70 ${dimmed ? "opacity-75" : ""}`}
      >
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <div>
              <CardTitle className="font-mono text-base">{sum.strategy.name}</CardTitle>
              <CardDescription className="line-clamp-2 mt-1 text-xs">
                {sum.strategy.description ?? ""}
              </CardDescription>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <Badge
                variant={status === "active" ? "default" : status === "halted" ? "destructive" : "secondary"}
                className="capitalize"
              >
                {status}
              </Badge>
              {barStatus && <BarStatusBadge status={barStatus} />}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* halt_reason gets a dedicated callout for retired/halted strategies.
              The reason text is excellent (often forensic-quality) and was
              previously hidden — you had to drill into /models/[id] to see it.
              Tucked under the description so the card layout stays compact. */}
          {haltReason && (status === "retired" || status === "halted") ? (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-2">
              <p className="text-[10px] uppercase tracking-wider text-amber-500/80">
                Halt reason
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground line-clamp-3">
                {haltReason}
              </p>
            </div>
          ) : null}

          <div className="flex items-baseline justify-between">
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Cumulative P&L</p>
              <p className={`text-2xl font-semibold ${pnlClass}`}>
                {fmtUsdSigned(sum.cumulativePnl)}
              </p>
              {/* Realized + unrealized split. Headline is MTM (real+unreal);
                  this breakdown reassures operators when the headline moves
                  but no positions have actually settled yet. */}
              {(sum.realizedPnl !== 0 || sum.unrealizedPnl !== 0) ? (
                <p className="mt-1 text-[10px] font-mono text-muted-foreground">
                  <span className={sum.realizedPnl > 0 ? "text-emerald-400/70" : sum.realizedPnl < 0 ? "text-red-400/70" : ""}>
                    real {fmtUsdSigned(sum.realizedPnl)}
                  </span>
                  <span className="mx-1">·</span>
                  <span className={sum.unrealizedPnl > 0 ? "text-emerald-400/70" : sum.unrealizedPnl < 0 ? "text-red-400/70" : ""}>
                    unreal {fmtUsdSigned(sum.unrealizedPnl)}
                  </span>
                </p>
              ) : null}
            </div>
            <div className="text-right">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">
                Cash / Bankroll
              </p>
              <p className="font-mono text-sm">
                {fmtUsd(sum.cashCurrent)} /{" "}
                {fmtUsd(Number(sum.strategy.startingBankroll))}
              </p>
              {sum.nOpen > 0 ? (
                <p className="font-mono text-[11px] text-amber-500/80 mt-0.5">
                  {fmtUsd(sum.totalOpenStake)} in {sum.nOpen} open
                </p>
              ) : null}
              {/* Coverage indicator — how many open positions actually have a
                  fresh price vs. fall back to cost-basis. Helps operators see
                  if the price-refresh cron is keeping up. Hidden when 100%. */}
              {sum.nOpen > 0 && sum.nOpenWithPrice < sum.nOpen ? (
                <p className="font-mono text-[10px] text-muted-foreground/70 mt-0.5">
                  {sum.nOpenWithPrice}/{sum.nOpen} priced
                </p>
              ) : null}
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
}

function HealthBanner({
  health,
}: {
  health: { ok: number; err: number; total: number };
}) {
  // Tone selection:
  //  - no firings yet → neutral grey (likely a fresh deploy or DB outage)
  //  - 0 errors → green
  //  - 1+ errors but <30% of firings → amber (degraded but operating)
  //  - ≥30% errors → red
  // Threshold is fairly generous because cron firings cluster (3 crons × 4
  // pollings = 12 firings/hour); 1 error in 12 is fine, 4+ is alarming.
  const errRate = health.total > 0 ? health.err / health.total : 0;
  let tone: "neutral" | "ok" | "warn" | "err";
  let label: string;
  if (health.total === 0) {
    tone = "neutral";
    label = "No cron firings recorded in the last hour";
  } else if (health.err === 0) {
    tone = "ok";
    label = "All systems healthy";
  } else if (errRate < 0.3) {
    tone = "warn";
    label = `Degraded — ${health.err} cron error${health.err === 1 ? "" : "s"} in the last hour`;
  } else {
    tone = "err";
    label = `Crons failing — ${health.err} of ${health.total} firings errored in the last hour`;
  }
  const cls = {
    neutral: "border-border/40 bg-muted/30 text-muted-foreground",
    ok: "border-emerald-500/30 bg-emerald-500/5 text-emerald-500",
    warn: "border-amber-500/40 bg-amber-500/5 text-amber-500",
    err: "border-red-500/40 bg-red-500/5 text-red-500",
  }[tone];
  return (
    <div
      className={`flex items-center justify-between rounded-md border px-4 py-2 text-sm ${cls}`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-2 w-2 rounded-full bg-current ${tone === "ok" || tone === "warn" || tone === "err" ? "animate-pulse" : ""}`}
        />
        <span className="font-medium">{label}</span>
      </div>
      <span className="text-xs opacity-70 font-mono">
        {health.ok}/{health.total} firings OK · last 1h
      </span>
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
