// Read-only "Methodology" panel rendered inside a TabsContent on the strategy
// detail page. Server component — no client interactivity needed.

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  FilterDescription,
  MethodologyMetrics,
  StrategyMethodology,
} from "@/lib/db/schema";

export function MethodologyTab({ m }: { m: StrategyMethodology }) {
  const filters = (m.filterDescriptions ?? []) as FilterDescription[];
  const inSample = m.inSampleMetrics ?? null;
  const forward = m.forwardMetrics ?? null;
  const perYear = m.perYearMetrics ?? {};
  const perYearKeys = Object.keys(perYear).sort();

  return (
    <div className="space-y-6">
      {/* Header card: bar status + hypothesis */}
      <Card className="border-border/60">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Hypothesis</CardTitle>
            <BarStatusBadge status={m.barStatus} />
          </div>
          <CardDescription>
            The economic intuition this strategy was designed to capture, and the
            evidence behind each filter.
          </CardDescription>
        </CardHeader>
        <Separator />
        <CardContent className="pt-6">
          <Markdown text={m.hypothesis} />
        </CardContent>
      </Card>

      {/* Validation metrics: in-sample + forward */}
      <Card className="border-border/60">
        <CardHeader>
          <CardTitle className="text-base">Validation metrics</CardTitle>
          <CardDescription>
            In-sample numbers come from the 21-month research backtest. Forward-OOS
            numbers come from the 2026 walk-forward held out for validation.
          </CardDescription>
        </CardHeader>
        <Separator />
        <CardContent className="pt-6">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <MetricsBlock title="In-sample" metrics={inSample} />
            <MetricsBlock title="Forward-OOS" metrics={forward} accent />
          </div>
        </CardContent>
      </Card>

      {/* Per-year breakdown */}
      {perYearKeys.length > 0 && (
        <Card className="border-border/60">
          <CardHeader>
            <CardTitle className="text-base">Per-year breakdown</CardTitle>
            <CardDescription>
              Mean realised return per dollar by calendar year. Bar height is
              proportional to mean ret/$; total $ shown next to each row.
            </CardDescription>
          </CardHeader>
          <Separator />
          <CardContent className="pt-6">
            <PerYearChart perYear={perYear} keys={perYearKeys} />
          </CardContent>
        </Card>
      )}

      {/* Filter list */}
      {filters.length > 0 && (
        <Card className="border-border/60">
          <CardHeader>
            <CardTitle className="text-base">Filters applied</CardTitle>
            <CardDescription>
              Each filter applied to every Goldsky-observed trade. The validation
              column links the filter to the experiment that justifies it.
            </CardDescription>
          </CardHeader>
          <Separator />
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[28%]">Filter</TableHead>
                  <TableHead className="w-[36%]">Description</TableHead>
                  <TableHead>Validation</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filters.map((f, i) => (
                  <TableRow key={i}>
                    <TableCell className="align-top font-mono text-xs">
                      {f.name}
                    </TableCell>
                    <TableCell className="align-top text-xs text-foreground/85">
                      {f.description}
                    </TableCell>
                    <TableCell className="align-top text-xs text-muted-foreground">
                      {f.validation}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Known issues */}
      {m.knownIssues && (
        <Card className="border-border/60">
          <CardHeader>
            <CardTitle className="text-base">Known issues / caveats</CardTitle>
            <CardDescription>
              Failure modes, fragility, and yellow flags worth monitoring on live
              data.
            </CardDescription>
          </CardHeader>
          <Separator />
          <CardContent className="pt-6">
            <Markdown text={m.knownIssues} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Bar-status badge — shared between leaderboard cards and the methodology tab.
// ─────────────────────────────────────────────────────────────────────────────
export function BarStatusBadge({ status }: { status: string }) {
  // Tone the badge by status. We use semantic colour classes so the badge stays
  // legible in dark + light theme.
  const tone = (() => {
    switch (status) {
      case "Bar 2 alpha":
        return "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30";
      case "Bar 1 floor":
        return "bg-sky-500/15 text-sky-300 border border-sky-500/30";
      case "borderline":
        return "bg-amber-500/15 text-amber-300 border border-amber-500/30";
      case "comparison":
        return "bg-muted text-muted-foreground border border-border/60";
      default:
        return "bg-muted text-muted-foreground border border-border/60";
    }
  })();
  return (
    <Badge variant="outline" className={`uppercase tracking-wider ${tone}`}>
      {status}
    </Badge>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MetricsBlock: a small KPI grid for in-sample / forward metrics.
// ─────────────────────────────────────────────────────────────────────────────
function MetricsBlock({
  title,
  metrics,
  accent,
}: {
  title: string;
  metrics: MethodologyMetrics | null;
  accent?: boolean;
}) {
  if (!metrics) {
    return (
      <div className="rounded-md border border-dashed border-border/60 p-4 text-xs text-muted-foreground">
        No {title.toLowerCase()} metrics recorded.
      </div>
    );
  }
  return (
    <div
      className={`rounded-md border p-4 ${
        accent ? "border-foreground/30 bg-card/40" : "border-border/60"
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-sm font-medium">{title}</h4>
        {metrics.span_label && (
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {metrics.span_label}
          </span>
        )}
      </div>
      <Separator className="my-3 bg-border/50" />
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <Metric label="Mean ret/$" value={fmtNumSigned(metrics.mean_ret_per_dollar)} />
        <Metric label="Total P&L" value={fmtUsdK(metrics.total_pnl)} />
        <Metric label="Bootstrap P5" value={fmtUsdK(metrics.p5)} />
        <Metric label="P_pos" value={fmtPct1(metrics.p_pos)} />
        <Metric label="N bets" value={fmtInt(metrics.n_bets)} />
        <Metric label="N markets" value={fmtInt(metrics.n_markets)} />
        {metrics.top1_pct != null && (
          <Metric label="Top-1 conc" value={`${metrics.top1_pct.toFixed(1)}%`} />
        )}
      </dl>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-border/40 pb-1.5">
      <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="font-mono text-foreground">{value}</dd>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PerYearChart: simple bar chart for mean ret/$ by year.
// ─────────────────────────────────────────────────────────────────────────────
function PerYearChart({
  perYear,
  keys,
}: {
  perYear: Record<string, MethodologyMetrics>;
  keys: string[];
}) {
  const values = keys.map((k) => perYear[k]?.mean_ret_per_dollar ?? 0);
  const maxAbs = Math.max(0.01, ...values.map((v) => Math.abs(v)));
  return (
    <div className="space-y-2">
      {keys.map((year) => {
        const m = perYear[year] ?? {};
        const v = m.mean_ret_per_dollar ?? 0;
        const widthPct = (Math.abs(v) / maxAbs) * 100;
        const isPos = v >= 0;
        return (
          <div key={year} className="space-y-1">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="font-mono text-foreground">{year}</span>
              <span className="text-muted-foreground">
                {m.span_label ?? ""}
                {m.span_label && m.total_pnl != null ? " · " : ""}
                {m.total_pnl != null ? fmtUsdK(m.total_pnl) : ""}
              </span>
            </div>
            <div className="relative h-4 rounded bg-muted/40">
              <div
                className={`absolute left-0 top-0 h-full rounded ${
                  isPos
                    ? "bg-emerald-500/40 border border-emerald-500/60"
                    : "bg-red-500/40 border border-red-500/60"
                }`}
                style={{ width: `${widthPct}%` }}
              />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[10px]">
                {fmtNumSigned(v)} ret/$
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiny markdown renderer — supports paragraphs, bullet lists, and inline
// **bold**. Kept dependency-free; the methodology copy uses a small subset.
// ─────────────────────────────────────────────────────────────────────────────
function Markdown({ text }: { text: string }) {
  const blocks = text.replace(/\r\n/g, "\n").split(/\n\n+/);
  return (
    <div className="space-y-3 text-sm text-foreground/90">
      {blocks.map((block, i) => {
        const trimmed = block.trim();
        if (!trimmed) return null;
        const lines = trimmed.split("\n");
        const isList = lines.every((l) => /^\s*[-*]\s+/.test(l));
        if (isList) {
          return (
            <ul
              key={i}
              className="list-disc space-y-1.5 pl-5 marker:text-muted-foreground"
            >
              {lines.map((l, j) => (
                <li key={j} className="text-sm">
                  {renderInline(l.replace(/^\s*[-*]\s+/, ""))}
                </li>
              ))}
            </ul>
          );
        }
        const numbered = lines.every((l) => /^\s*\d+\.\s+/.test(l));
        if (numbered) {
          return (
            <ol
              key={i}
              className="list-decimal space-y-1.5 pl-5 marker:text-muted-foreground"
            >
              {lines.map((l, j) => (
                <li key={j} className="text-sm">
                  {renderInline(l.replace(/^\s*\d+\.\s+/, ""))}
                </li>
              ))}
            </ol>
          );
        }
        return (
          <p key={i} className="leading-relaxed">
            {renderInline(trimmed)}
          </p>
        );
      })}
    </div>
  );
}

function renderInline(s: string): React.ReactNode {
  // Split on **bold** segments and emit <strong> elements.
  const parts: React.ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    parts.push(
      <strong key={key++} className="font-medium text-foreground">
        {m[1]}
      </strong>,
    );
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push(s.slice(last));
  return parts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Local formatters (no dep on lib/format — these have specific number bands).
// ─────────────────────────────────────────────────────────────────────────────
function fmtNumSigned(v: number | undefined | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
}
function fmtUsdK(v: number | undefined | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v >= 0 ? "+" : "−";
  const abs = Math.abs(v);
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}
function fmtPct1(v: number | undefined | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(0)}%`;
}
function fmtInt(v: number | undefined | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toLocaleString();
}
