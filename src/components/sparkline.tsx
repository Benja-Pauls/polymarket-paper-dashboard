"use client";

import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";

type Pt = { x: string | number; y: number };

export function Sparkline({
  data,
  positiveColor = "oklch(0.78 0.16 156)",
  negativeColor = "oklch(0.65 0.22 22)",
}: {
  data: Pt[];
  positiveColor?: string;
  negativeColor?: string;
}) {
  if (data.length === 0) return null;
  const last = data[data.length - 1].y;
  const stroke = last >= 0 ? positiveColor : negativeColor;
  const ys = data.map((d) => d.y);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  // Pad domain so a flat line still draws inside the chart area.
  const pad = Math.max(1, (yMax - yMin) * 0.15);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 2, bottom: 2, left: 0, right: 0 }}>
        <YAxis hide domain={[yMin - pad, yMax + pad]} />
        <Line
          type="monotone"
          dataKey="y"
          stroke={stroke}
          strokeWidth={1.75}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
