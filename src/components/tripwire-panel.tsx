import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtUsd, fmtPct } from "@/lib/format";
import type { TripwireStatus } from "@/lib/strategy";

const STATE_DOT: Record<TripwireStatus["cumulativeLoss"]["state"], string> = {
  green: "bg-emerald-400",
  yellow: "bg-amber-400",
  red: "bg-red-400",
};

export function TripwirePanel({ status }: { status: TripwireStatus }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <TripwireCard
        title="Cumulative loss"
        description="Halt if total P&L falls below 30% of starting bankroll."
        state={status.cumulativeLoss.state}
        valueLabel={fmtUsd(-status.cumulativeLoss.value)}
        thresholdLabel={`limit ${fmtUsd(-status.cumulativeLoss.threshold)}`}
        progress={Math.min(1, Math.max(0, status.cumulativeLoss.value / status.cumulativeLoss.threshold))}
      />
      <TripwireCard
        title="Weekly P&L"
        description="Halt if 7-day P&L falls below 20% of starting bankroll."
        state={status.weeklyLoss.state}
        valueLabel={fmtUsd(-status.weeklyLoss.value)}
        thresholdLabel={`limit ${fmtUsd(-status.weeklyLoss.threshold)}`}
        progress={Math.min(1, Math.max(0, status.weeklyLoss.value / status.weeklyLoss.threshold))}
      />
      <TripwireCard
        title="Top-1 concentration"
        description="Halt if any single market exceeds 50% of |total P&L|."
        state={status.top1Concentration.state}
        valueLabel={fmtPct(status.top1Concentration.value / 100, 1)}
        thresholdLabel={`limit ${fmtPct(status.top1Concentration.threshold / 100, 0)}`}
        progress={Math.min(
          1,
          Math.max(0, status.top1Concentration.value / status.top1Concentration.threshold),
        )}
      />
    </div>
  );
}

function TripwireCard({
  title,
  description,
  state,
  valueLabel,
  thresholdLabel,
  progress,
}: {
  title: string;
  description: string;
  state: TripwireStatus["cumulativeLoss"]["state"];
  valueLabel: string;
  thresholdLabel: string;
  progress: number;
}) {
  return (
    <Card className="border-border/70">
      <CardHeader className="space-y-1">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
          <span className={`h-2.5 w-2.5 rounded-full ${STATE_DOT[state]} shadow-[0_0_12px]`} />
        </div>
        <CardDescription className="text-xs">{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-base">{valueLabel}</span>
          <span className="font-mono text-[11px] text-muted-foreground">{thresholdLabel}</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/40">
          <div
            className={`h-full transition-all ${state === "red" ? "bg-red-400" : state === "yellow" ? "bg-amber-400" : "bg-emerald-400"}`}
            style={{ width: `${(progress * 100).toFixed(1)}%` }}
          />
        </div>
      </CardContent>
    </Card>
  );
}
