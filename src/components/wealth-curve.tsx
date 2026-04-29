"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type Point = { date: string; cumulativePnl: number; cash: number; realizedPnl: number };

export function WealthCurve({ data }: { data: Point[] }) {
  if (data.length === 0) {
    return (
      <div className="flex h-72 items-center justify-center rounded-lg border border-dashed border-border/60 bg-muted/10 text-sm text-muted-foreground">
        No daily snapshots yet — first cron run will create one.
      </div>
    );
  }
  return (
    <div className="h-72">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: -10 }}>
          <CartesianGrid strokeDasharray="2 4" stroke="oklch(1 0 0 / 6%)" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11, fill: "oklch(0.7 0 0)" }}
            tickMargin={6}
            axisLine={{ stroke: "oklch(1 0 0 / 12%)" }}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "oklch(0.7 0 0)" }}
            tickFormatter={(v) =>
              `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
            }
            axisLine={{ stroke: "oklch(1 0 0 / 12%)" }}
            tickLine={false}
            width={64}
          />
          <Tooltip
            contentStyle={{
              background: "oklch(0.205 0 0)",
              border: "1px solid oklch(1 0 0 / 12%)",
              borderRadius: 8,
              color: "oklch(0.985 0 0)",
              fontSize: 12,
            }}
            formatter={(v) =>
              `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 })}`
            }
            labelStyle={{ color: "oklch(0.7 0 0)" }}
          />
          <Line
            type="monotone"
            dataKey="cumulativePnl"
            name="Cumulative P&L"
            stroke="oklch(0.78 0.16 156)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="realizedPnl"
            name="Realized P&L"
            stroke="oklch(0.7 0.05 256)"
            strokeWidth={1.25}
            strokeDasharray="3 3"
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
