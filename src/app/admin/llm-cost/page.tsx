// Admin > LLM Cost — observability for Anthropic API spend on this project.
//
// Today we have ONE active LLM call site: the market classifier, which
// categorizes Polymarket markets into tradeable / non-tradeable buckets so
// the strategies know what to filter on. Two crons fire it:
//   - sync-open-markets (hourly bulk classification of new open markets)
//   - poll              (lazy classification of markets first seen in fills)
//
// The v12 LLM evaluator (Kelly-sizing via probability estimate) was halted
// 2026-05-01 after forward-OOS validation showed catastrophic overfit, so
// no strategy currently has llm_evaluator_enabled=true; that call site
// fires zero times in production. We still surface it as a row labeled
// "(idle)" so operators can confirm it's NOT spending money.
//
// Cost source: each cron's recordCronRun() writes a row to cron_runs with
// result_json. We sum the cost fields from there:
//   sync-open-markets:  result_json.llm_calls_estimated_cost_usd
//   poll:               result_json.lazy_llm_cost_usd
//
// Per-call cost is hardcoded at $0.0002 in src/lib/classify/index.ts
// (~200 input + 12 output Haiku tokens at published 2026-Q2 rates). We
// don't pull live billing from Anthropic — this is an estimate intended to
// be within ±10% of actual spend.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { cronRuns } from "@/lib/db/schema";
import { fmtCST } from "@/lib/format";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Time windows for the rollup. Keeping these symbolic so it's easy to add
// a 7d if the spend pattern motivates it.
const WINDOWS = [
  { label: "24 hours", hours: 24 },
  { label: "7 days", hours: 7 * 24 },
  { label: "30 days", hours: 30 * 24 },
] as const;

type WindowRoll = {
  label: string;
  hours: number;
  // Per cron name → aggregate stats in the window
  byCron: Map<
    string,
    {
      runs: number;
      total_calls: number;
      total_cost_usd: number;
    }
  >;
};

async function rollUp(): Promise<WindowRoll[]> {
  const out: WindowRoll[] = [];
  for (const w of WINDOWS) {
    const since = new Date(Date.now() - w.hours * 3600 * 1000);
    // Pull cron_runs in the window with non-null result_json. Aggregate
    // per cron name. SQL extracts cost + call counts from JSON; null/zero
    // entries are coerced to 0 so a cron that didn't make any LLM calls
    // still shows up.
    const rows = await db.execute<{
      cron_name: string;
      runs: number;
      total_calls: number;
      total_cost_usd: number;
    }>(sql`
      SELECT
        cron_name,
        count(*)::int AS runs,
        coalesce(sum(
          coalesce((result_json->>'classified_via_llm')::int, 0) +
          coalesce((result_json->>'lazy_llm_calls_completed')::int, 0)
        ), 0)::int AS total_calls,
        coalesce(sum(
          coalesce((result_json->>'llm_calls_estimated_cost_usd')::float, 0) +
          coalesce((result_json->>'lazy_llm_cost_usd')::float, 0)
        ), 0)::float AS total_cost_usd
      FROM cron_runs
      WHERE started_at >= ${since}
      GROUP BY cron_name
    `);
    const byCron = new Map<
      string,
      { runs: number; total_calls: number; total_cost_usd: number }
    >();
    for (const r of rows.rows ?? []) {
      byCron.set(r.cron_name, {
        runs: Number(r.runs),
        total_calls: Number(r.total_calls),
        total_cost_usd: Number(r.total_cost_usd),
      });
    }
    out.push({ label: w.label, hours: w.hours, byCron });
  }
  return out;
}

// Recent cron runs that actually made LLM calls — for the "what were the
// recent calls" table at the bottom of the page.
async function recentCallingRuns(limit = 30) {
  const rows = await db.execute<{
    cron_name: string;
    started_at: Date;
    duration_ms: number;
    status: string;
    classified_via_llm: number | null;
    lazy_llm_calls_completed: number | null;
    llm_calls_estimated_cost_usd: number | null;
    lazy_llm_cost_usd: number | null;
  }>(sql`
    SELECT
      cron_name,
      started_at,
      duration_ms,
      status,
      (result_json->>'classified_via_llm')::int        AS classified_via_llm,
      (result_json->>'lazy_llm_calls_completed')::int  AS lazy_llm_calls_completed,
      (result_json->>'llm_calls_estimated_cost_usd')::float AS llm_calls_estimated_cost_usd,
      (result_json->>'lazy_llm_cost_usd')::float       AS lazy_llm_cost_usd
    FROM cron_runs
    WHERE
      coalesce((result_json->>'classified_via_llm')::int, 0) +
      coalesce((result_json->>'lazy_llm_calls_completed')::int, 0) > 0
    ORDER BY started_at DESC
    LIMIT ${limit}
  `);
  return rows.rows ?? [];
}

// Most recently classified markets — gives operators concrete examples of
// what the LLM was deciding ON. We can't show the exact LLM input/output
// (we'd have to log every call's response, which would balloon log volume
// for marginal benefit), but we can show the OUTCOMES: market → category.
async function recentClassifications(limit = 25) {
  const rows = await db.execute<{
    condition_id: string;
    question_text: string | null;
    category: string | null;
    updated_at: Date;
  }>(sql`
    SELECT condition_id, question_text, category, updated_at
    FROM markets
    WHERE category IS NOT NULL
      AND question_text IS NOT NULL
      AND updated_at >= now() - interval '24 hours'
    ORDER BY updated_at DESC
    LIMIT ${limit}
  `);
  return rows.rows ?? [];
}

export default async function LlmCostPage() {
  const [windows, recentRuns, recentClass] = await Promise.all([
    rollUp(),
    recentCallingRuns(),
    recentClassifications(),
  ]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold mb-1">LLM Cost</h1>
        <p className="text-sm text-muted-foreground">
          Anthropic API spend on this project, aggregated from{" "}
          <code className="font-mono text-xs">cron_runs.result_json</code>.
          Estimates only — within ~±10% of actual Anthropic billing.
        </p>
      </div>

      {/* What this is — explainer card so operators understand what model
          fires when, what for, and where in the code to look. */}
      <section className="rounded-lg border border-border/40 bg-card/30 p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold">What's spending money?</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Two LLM call sites in this codebase. Today only one is active.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <CallSiteCard
            label="Market classifier"
            status="ACTIVE"
            statusTone="ok"
            model="claude-haiku-4-5"
            purpose="Read a Polymarket market's question text and assign a category like tradeable_geopolitical, not_tradeable_sports, or ambiguous. Strategies use these categories to decide whether the market is in their universe."
            costPerCall="~$0.0002 (≈200 input + 12 output tokens)"
            firedFrom={[
              {
                cron: "sync-open-markets",
                detail:
                  "Hourly bulk classify of new open markets pulled from Gamma. Caps at 1500 calls/run, $5 budget.",
              },
              {
                cron: "poll",
                detail:
                  "Every 15 min, lazy-classify any new condition_id seen in fills that we haven't categorized yet. $1 budget cap per run.",
              },
            ]}
            sourceFile="src/lib/classify/index.ts"
          />
          <CallSiteCard
            label="Bet evaluator (v12)"
            status="IDLE"
            statusTone="muted"
            model="claude-haiku-4-5"
            purpose="Tetlockian-decomposition prompt that returns a calibrated probability the bet wins, used to compute a Kelly stake multiplier. Wraps each candidate bet in a ~$0.001-0.003 call."
            costPerCall="~$0.001-0.003"
            firedFrom={[
              {
                cron: "poll",
                detail:
                  "Only fires for strategies with params_json.llm_evaluator_enabled=true. v12_llm_kelly_haiku was the only such strategy and was retired 2026-05-01 after forward-OOS validation showed catastrophic overfit. Currently zero active strategies enable this.",
              },
            ]}
            sourceFile="src/lib/llm-evaluator/index.ts"
          />
        </div>
      </section>

      {/* Rollup: total cost per window per cron */}
      <section>
        <h2 className="text-base font-semibold mb-3">Rollup</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {windows.map((w) => {
            const totalCost = [...w.byCron.values()].reduce(
              (a, b) => a + b.total_cost_usd,
              0,
            );
            const totalCalls = [...w.byCron.values()].reduce(
              (a, b) => a + b.total_calls,
              0,
            );
            return (
              <div key={w.label} className="rounded-lg border border-border/40 p-4">
                <p className="text-[11px] uppercase text-muted-foreground tracking-wide">
                  Last {w.label}
                </p>
                <p className="mt-1 text-2xl font-semibold font-mono">
                  ${totalCost.toFixed(4)}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {totalCalls.toLocaleString()} LLM calls
                </p>
                <table className="mt-3 w-full text-xs">
                  <tbody>
                    {[...w.byCron.entries()]
                      .sort((a, b) => b[1].total_cost_usd - a[1].total_cost_usd)
                      .map(([name, stats]) => (
                        <tr key={name} className="border-t border-border/30">
                          <td className="py-1 pr-2 text-muted-foreground font-mono">
                            {name}
                          </td>
                          <td className="py-1 text-right font-mono">
                            ${stats.total_cost_usd.toFixed(4)}
                          </td>
                          <td className="py-1 pl-2 text-right text-muted-foreground">
                            {stats.total_calls}
                          </td>
                        </tr>
                      ))}
                    {w.byCron.size === 0 && (
                      <tr>
                        <td colSpan={3} className="py-2 text-center text-muted-foreground italic">
                          no cron runs in this window
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      </section>

      {/* Recent runs that actually made LLM calls */}
      <section>
        <h2 className="text-base font-semibold mb-2">Recent runs with LLM calls</h2>
        <p className="text-xs text-muted-foreground mb-3">
          The last {recentRuns.length} cron firings that hit the Anthropic API.
          Sorted newest-first.
        </p>
        <div className="rounded-lg border border-border/40 overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-muted/30">
              <tr>
                <Th>When (CST)</Th>
                <Th>Cron</Th>
                <Th>Status</Th>
                <Th align="right">Calls</Th>
                <Th align="right">Cost</Th>
                <Th align="right">Duration</Th>
              </tr>
            </thead>
            <tbody>
              {recentRuns.map((r, i) => {
                const calls =
                  Number(r.classified_via_llm ?? 0) +
                  Number(r.lazy_llm_calls_completed ?? 0);
                const cost =
                  Number(r.llm_calls_estimated_cost_usd ?? 0) +
                  Number(r.lazy_llm_cost_usd ?? 0);
                return (
                  <tr key={i} className="border-t border-border/30">
                    <Td className="font-mono">{fmtCST(r.started_at)}</Td>
                    <Td className="font-mono">{r.cron_name}</Td>
                    <Td>
                      <span
                        className={
                          r.status === "ok" ? "text-emerald-500" : "text-red-500"
                        }
                      >
                        {r.status}
                      </span>
                    </Td>
                    <Td align="right" className="font-mono">{calls}</Td>
                    <Td align="right" className="font-mono">${cost.toFixed(4)}</Td>
                    <Td align="right" className="font-mono text-muted-foreground">
                      {(Number(r.duration_ms) / 1000).toFixed(1)}s
                    </Td>
                  </tr>
                );
              })}
              {recentRuns.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-4 text-center text-muted-foreground italic">
                    No cron runs with LLM calls yet (poll fires every 15 min, sync hourly)
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* What the LLM actually decided — show recent classification outcomes
          since that's what the model was called for. We can't show the exact
          LLM responses (logging every call doubles log volume) but the
          markets table records what category got assigned. */}
      <section>
        <h2 className="text-base font-semibold mb-2">Recent classifications (last 24h)</h2>
        <p className="text-xs text-muted-foreground mb-3">
          What the classifier was actually called <em>on</em> and what verdict
          it returned. The full LLM input is the question text shown here +
          the classification prompt in{" "}
          <code className="font-mono">src/lib/classify/index.ts</code>; the
          output is the category column.
        </p>
        <div className="rounded-lg border border-border/40 overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-muted/30">
              <tr>
                <Th>Updated (CST)</Th>
                <Th>Question</Th>
                <Th>Category</Th>
              </tr>
            </thead>
            <tbody>
              {recentClass.map((r, i) => (
                <tr key={i} className="border-t border-border/30">
                  <Td className="font-mono whitespace-nowrap">
                    {fmtCST(r.updated_at)}
                  </Td>
                  <Td className="max-w-md">
                    <span className="line-clamp-2">{r.question_text}</span>
                  </Td>
                  <Td>
                    <span
                      className={
                        r.category?.startsWith("tradeable_")
                          ? "text-emerald-400"
                          : r.category?.startsWith("not_tradeable_")
                            ? "text-muted-foreground"
                            : "text-amber-500"
                      }
                    >
                      {r.category}
                    </span>
                  </Td>
                </tr>
              ))}
              {recentClass.length === 0 && (
                <tr>
                  <td colSpan={3} className="py-4 text-center text-muted-foreground italic">
                    No markets classified in the last 24h
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function CallSiteCard({
  label,
  status,
  statusTone,
  model,
  purpose,
  costPerCall,
  firedFrom,
  sourceFile,
}: {
  label: string;
  status: string;
  statusTone: "ok" | "warn" | "muted";
  model: string;
  purpose: string;
  costPerCall: string;
  firedFrom: Array<{ cron: string; detail: string }>;
  sourceFile: string;
}) {
  const toneClass = {
    ok: "border-emerald-500/30 bg-emerald-500/5 text-emerald-500",
    warn: "border-amber-500/30 bg-amber-500/5 text-amber-500",
    muted: "border-border/40 bg-muted/30 text-muted-foreground",
  }[statusTone];
  return (
    <div className="rounded-lg border border-border/40 p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-semibold">{label}</p>
          <p className="text-[11px] text-muted-foreground font-mono mt-0.5">
            {model}
          </p>
        </div>
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${toneClass}`}
        >
          {status}
        </span>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">{purpose}</p>
      <div className="text-xs">
        <span className="text-muted-foreground">Cost per call:</span>{" "}
        <span className="font-mono">{costPerCall}</span>
      </div>
      <div>
        <p className="text-[11px] uppercase text-muted-foreground tracking-wide">
          Fired from
        </p>
        <ul className="mt-1 space-y-1.5">
          {firedFrom.map((f) => (
            <li key={f.cron} className="text-xs">
              <code className="font-mono text-foreground">{f.cron}</code>
              <span className="text-muted-foreground"> — {f.detail}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-[11px] text-muted-foreground border-t border-border/30 pt-2">
        Source:{" "}
        <code className="font-mono">{sourceFile}</code>
      </p>
    </div>
  );
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th className={`px-3 py-2 font-medium text-${align}`}>{children}</th>
  );
}

function Td({
  children,
  align = "left",
  className = "",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <td className={`px-3 py-1.5 text-${align} ${className}`}>{children}</td>
  );
}
