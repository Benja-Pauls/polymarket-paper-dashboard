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
import {
  fmtDate,
  fmtPrice,
  fmtTs,
  fmtUsd,
  shortAddr,
  shortCid,
} from "@/lib/format";
import { getMarketDetail, getStrategy } from "@/lib/queries";
import type { StrategyParams } from "@/lib/strategy";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function MarketDetailPage({
  params,
}: {
  params: Promise<{ strategyId: string; marketId: string }>;
}) {
  const { strategyId, marketId } = await params;
  const strategy = await getStrategy(strategyId);
  if (!strategy) notFound();

  const detail = await getMarketDetail(strategyId, marketId);
  if (!detail) notFound();
  const { market, positions, signals } = detail;

  // Capture request-time timestamp once before render so the WhyThisMarket
  // helper stays pure. Page is force-dynamic so this is fine.
  // eslint-disable-next-line react-hooks/purity
  const nowSeconds = Math.floor(Date.now() / 1000);

  const winnerLabel =
    market.winnerOutcomeIdx == null
      ? "unresolved"
      : `outcome ${market.winnerOutcomeIdx}`;
  const polymarketUrl = `https://polymarket.com/markets/${market.conditionId}`;

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Link href="/" className="hover:text-foreground">
          Leaderboard
        </Link>
        <span>/</span>
        <Link href={`/models/${strategyId}`} className="hover:text-foreground">
          {strategy.name}
        </Link>
        <span>/</span>
        <span className="text-foreground font-mono">{shortCid(market.conditionId)}</span>
      </div>

      <header className="space-y-2">
        <h1 className="text-xl font-medium leading-tight">
          {market.questionText ?? shortCid(market.conditionId)}
        </h1>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="secondary">{market.category ?? "uncategorized"}</Badge>
          <Badge variant={market.resolved ? "destructive" : "default"}>
            {market.resolved ? `resolved · ${winnerLabel}` : "open"}
          </Badge>
          {market.resolutionTimestamp != null && (
            <span className="font-mono text-muted-foreground">
              resolves {fmtDate(market.resolutionTimestamp)}
            </span>
          )}
          <a
            href={polymarketUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto text-muted-foreground hover:text-foreground"
          >
            view on polymarket ↗
          </a>
        </div>
        <p className="font-mono text-[11px] text-muted-foreground break-all">
          {market.conditionId}
        </p>
      </header>

      <WhyThisMarket
        market={market}
        strategyName={strategy.name}
        params={(strategy.paramsJson as unknown as StrategyParams) ?? null}
        nowSeconds={nowSeconds}
      />

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="border-border/60">
          <CardHeader>
            <CardTitle className="text-base">Our positions</CardTitle>
            <CardDescription>
              All paper positions {strategy.name} has taken in this market.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {positions.length === 0 ? (
              <p className="px-6 pb-6 text-sm text-muted-foreground">
                No positions yet.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Outcome</TableHead>
                    <TableHead className="text-right">Entry</TableHead>
                    <TableHead className="text-right">Stake</TableHead>
                    <TableHead className="text-right">Payout</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Entered</TableHead>
                    <TableHead>Settled</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {positions.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-mono">{p.betOutcome}</TableCell>
                      <TableCell className="text-right font-mono">{fmtPrice(p.entryPrice)}</TableCell>
                      <TableCell className="text-right font-mono">{fmtUsd(Number(p.stake))}</TableCell>
                      <TableCell className="text-right font-mono">
                        {p.payout == null ? "—" : fmtUsd(p.payout)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            p.settledTs == null
                              ? "default"
                              : p.won === 1
                                ? "default"
                                : "destructive"
                          }
                        >
                          {p.settledTs == null ? "open" : p.won === 1 ? "won" : "lost"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {fmtTs(Number(p.entryTs))}
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

        <Card className="border-border/60">
          <CardHeader>
            <CardTitle className="text-base">Trade signals on this market</CardTitle>
            <CardDescription>
              Every Goldsky-observed trade in this market that {strategy.name} evaluated, ordered
              newest first.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {signals.length === 0 ? (
              <p className="px-6 pb-6 text-sm text-muted-foreground">
                No signals recorded for this market.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Wallet</TableHead>
                    <TableHead>Decision</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead>Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {signals.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="text-xs text-muted-foreground">
                        {fmtTs(Number(s.rawTs))}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{shortAddr(s.rawWallet)}</TableCell>
                      <TableCell>
                        <Badge variant={s.decision === "bet" ? "default" : "secondary"}>
                          {s.decision}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {fmtPrice(s.entryPrice ?? s.rawPrice)}
                      </TableCell>
                      <TableCell className="max-w-[28ch] text-xs text-muted-foreground">
                        <span className="line-clamp-1">{s.reason}</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// "Why this market matched" — per-decision trace explaining which strategy
// filters this market satisfies based on the strategy's params. Static checks
// only (category, ep_lo/hi at trade time, hours_to_res, max volume,
// require_future_catalyst). The actual per-trade verdicts live in the
// signals table; this callout is a quick orient at the top of the page.
// ─────────────────────────────────────────────────────────────────────────────
function WhyThisMarket({
  market,
  strategyName,
  params,
  nowSeconds,
}: {
  market: { category: string | null; resolutionTimestamp: number | null };
  strategyName: string;
  params: StrategyParams | null;
  nowSeconds: number;
}) {
  if (!params) return null;
  const checks: { label: string; pass: boolean; detail: string }[] = [];

  // Category
  const catOk =
    market.category != null && params.categories.includes(market.category);
  checks.push({
    label: "Category whitelist",
    pass: catOk,
    detail: catOk
      ? `${market.category} ∈ {${params.categories.join(", ")}}`
      : `${market.category ?? "uncategorized"} NOT in {${params.categories.join(", ")}}`,
  });

  // Time-to-resolution
  if (market.resolutionTimestamp != null) {
    const hoursToRes = (market.resolutionTimestamp - nowSeconds) / 3600;
    const hoursOk = hoursToRes >= params.min_hours_to_res;
    checks.push({
      label: `Time-to-resolution ≥ ${params.min_hours_to_res}h`,
      pass: hoursOk,
      detail:
        hoursToRes > 0
          ? `${hoursToRes.toFixed(1)}h until resolution (now)`
          : `Already resolved or past resolution timestamp`,
    });
  } else {
    checks.push({
      label: `Time-to-resolution ≥ ${params.min_hours_to_res}h`,
      pass: false,
      detail: "No resolution timestamp recorded",
    });
  }

  // Volume cap (informational — actual eval uses running volume at trade time)
  if (params.max_market_volume != null) {
    checks.push({
      label: `Market volume < $${params.max_market_volume.toLocaleString()}`,
      pass: true,
      detail:
        "Evaluated per-trade against cumulative on-chain notional at the moment of the trade.",
    });
  }

  // Catalyst requirement (informational)
  if (params.require_future_catalyst === true) {
    checks.push({
      label: "Future public catalyst required",
      pass: true,
      detail:
        "Per-trade check: market must have a catalyst record AND its catalyst_ts must be > trade_ts.",
    });
  }

  // Day-of-week skip (informational)
  if (params.skip_dow_utc && params.skip_dow_utc.length > 0) {
    const days = params.skip_dow_utc
      .map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d])
      .join(", ");
    checks.push({
      label: `Skip day-of-week`,
      pass: true,
      detail: `Trades that fall on ${days} UTC are skipped per strategy filter.`,
    });
  }

  return (
    <Card className="border-border/60">
      <CardHeader>
        <CardTitle className="text-base">Why this market matched</CardTitle>
        <CardDescription>
          Static check of how this market lines up against {strategyName}&apos;s filters.
          Per-trade verdicts (entry-price band, market-volume cap, cap-per-market) live in the
          signals table on the right.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {checks.map((c, i) => (
            <li key={i} className="flex items-start gap-3">
              <Badge
                variant={c.pass ? "default" : "destructive"}
                className="mt-0.5 shrink-0 uppercase"
              >
                {c.pass ? "pass" : "fail"}
              </Badge>
              <div className="flex-1 text-xs">
                <div className="font-medium text-foreground">{c.label}</div>
                <div className="text-muted-foreground">{c.detail}</div>
              </div>
            </li>
          ))}
          <li className="flex items-start gap-3 border-t border-border/40 pt-2">
            <Badge variant="secondary" className="mt-0.5 shrink-0 uppercase">
              per-trade
            </Badge>
            <div className="flex-1 text-xs">
              <div className="font-medium text-foreground">
                Entry price ∈ [{params.ep_lo}, {params.ep_hi}) · cap ≤ {params.cap_per_market} bets/market
              </div>
              <div className="text-muted-foreground">
                Evaluated per-trade. See the signals table for the actual decision and reason on
                each Goldsky-observed trade.
              </div>
            </div>
          </li>
        </ul>
      </CardContent>
    </Card>
  );
}
