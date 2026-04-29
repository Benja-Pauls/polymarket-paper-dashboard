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
