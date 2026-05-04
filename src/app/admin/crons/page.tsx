// Admin > Crons — observability for the scheduled jobs.
//
// What it shows for each cron:
//   - Schedule (cron expression + human-readable)
//   - What it does (description)
//   - Next fire time (countdown, CST)
//   - Last run started/finished (CST), duration, status
//   - Truncated last result JSON (so you can see e.g. trades_fetched, bets_placed)
//   - Recent run history (10 most recent)
//
// Data source: `cron_runs` table, written by recordCronRun() in
// src/lib/cron-tracker.ts at the end of every cron handler.

import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { cronRuns, type CronRun } from "@/lib/db/schema";
import { fmtCST, fmtAgo, fmtCountdown, nextCronFire } from "@/lib/format";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Keep this in sync with vercel.ts. We could read vercel.ts at build time but
// that needs an extra import path; the duplication is tiny and intentional.
type CronDef = {
  name: string;
  path: string;
  schedule: string;
  schedule_human: string;
  description: string;
};

const CRONS: CronDef[] = [
  {
    name: "poll",
    path: "/api/cron/poll",
    schedule: "*/15 * * * *",
    schedule_human: "every 15 minutes",
    description:
      "Fetches new fills from Polymarket data-api, lazy-classifies new markets via Claude Haiku 4.5 (free static label index first), evaluates every active strategy against every fill, persists signals + positions, settles resolved bets, takes a daily P&L snapshot.",
  },
  {
    name: "sync-open-markets",
    path: "/api/cron/sync-open-markets",
    schedule: "0 * * * *",
    schedule_human: "every hour",
    description:
      "Refreshes the OPEN-markets universe from Polymarket Gamma. For each open market: looks up its category in the static label index (free), falls back to Claude Haiku 4.5 (~$0.0001/market). Upserts (condition_id, question_text, category, resolution_timestamp) so strategies have endDate to filter on. Bumped 6h→1h on 2026-04-29 after the resolution-ts gap fix; 1500 LLM calls/run, hourly cadence drains the LLM-needed backlog faster.",
  },
  {
    name: "refresh-position-prices",
    path: "/api/cron/refresh-position-prices",
    schedule: "*/5 * * * *",
    schedule_human: "every 5 minutes",
    description:
      "Fetches current YES price from Polymarket Gamma for every market where some strategy has an open position (typically <300 cids). Powers the dashboard's mark-to-market unrealized P&L view — without this the dashboard would be stuck at cost-basis (entry-price) values until each position resolves, which can take 30+ days. Cheap: one Gamma round-trip per ~25 cids, no LLM calls. Independent of sync-open-markets (which scans all 25K open markets hourly and has its own price-capture pass).",
  },
  {
    name: "prune-signals",
    path: "/api/cron/prune-signals",
    schedule: "0 */4 * * *",
    schedule_human: "every 4 hours",
    description:
      "Deletes skip signals older than 24h. Defense-in-depth: as of 2026-05-03 the poll cron no longer writes skip signals to DB by default (LOG_SKIP_SIGNALS_TO_DB=false; they go to Vercel runtime logs as `[skip] strategy=… cid=… reason=…` lines). This cron stays scheduled to drain any historical skip rows and to keep things tidy if an operator flips the env flag back on for forensics. Bet signals (FK-referenced by positions, aggregated by /admin/edge-rate) are never deleted. Plain VACUUM after delete; explicit VACUUM FULL reserved for manual operator action.",
  },
];

// Use Drizzle's inferred type — fields are camelCase (cronName, startedAt,
// finishedAt, durationMs, errorMessage). Earlier the page used a snake_case
// LastRunRow type cast via `as unknown as LastRunRow`, which silently broke
// the timestamp/duration display ("Last run started: —", "Duration: NaNs")
// because every field access was undefined.
type LastRunRow = CronRun;

export default async function CronsPage() {
  const nowMs = Date.now();

  // Latest run per cron + recent run history (last 10 per cron).
  const lastByName = new Map<string, LastRunRow>();
  const recentByName = new Map<string, LastRunRow[]>();
  for (const c of CRONS) {
    const recent = await db
      .select()
      .from(cronRuns)
      .where(eq(cronRuns.cronName, c.name))
      .orderBy(desc(cronRuns.startedAt))
      .limit(10);
    if (recent.length > 0) {
      lastByName.set(c.name, recent[0]);
      recentByName.set(c.name, recent);
    }
  }

  // Aggregate stats — cron run counts per name, last 24h.
  const dayAgo = new Date(nowMs - 24 * 3600 * 1000);
  const stats24h = await db
    .select({
      name: cronRuns.cronName,
      total: sql<number>`count(*)::int`,
      ok: sql<number>`count(*) FILTER (WHERE status='ok')::int`,
      err: sql<number>`count(*) FILTER (WHERE status='error')::int`,
      avg_dur_ms: sql<number>`avg(duration_ms)::int`,
    })
    .from(cronRuns)
    .where(sql`started_at >= ${dayAgo}`)
    .groupBy(cronRuns.cronName);
  const statsByName = new Map(stats24h.map((s) => [s.name, s]));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold mb-1">Crons</h1>
        <p className="text-sm text-muted-foreground">
          Vercel scheduled-job runtime view. {fmtCST(new Date(nowMs))}.
        </p>
      </div>

      {CRONS.map((cron) => {
        const last = lastByName.get(cron.name);
        const next = nextCronFire(cron.schedule, nowMs);
        const stats = statsByName.get(cron.name);
        const recent = recentByName.get(cron.name) ?? [];
        return (
          <section key={cron.name} className="border rounded-lg overflow-hidden">
            <header className="bg-muted/30 px-4 py-3 flex flex-wrap items-baseline gap-x-6 gap-y-1">
              <h2 className="text-lg font-semibold">{cron.name}</h2>
              <code className="text-xs bg-background px-2 py-0.5 rounded border">
                {cron.schedule}
              </code>
              <span className="text-sm text-muted-foreground">
                {cron.schedule_human}
              </span>
              <span className="ml-auto text-sm">
                {next ? (
                  <>
                    <span className="text-muted-foreground">Next: </span>
                    <span className="font-medium">{fmtCountdown(next, nowMs)}</span>
                    <span className="text-muted-foreground"> ({fmtCST(next)})</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">
                    schedule pattern not parseable
                  </span>
                )}
              </span>
            </header>

            <div className="p-4 grid gap-6 lg:grid-cols-2">
              <div>
                <h3 className="text-sm font-semibold mb-2">What it does</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {cron.description}
                </p>
                {stats ? (
                  <div className="mt-4 grid grid-cols-4 gap-3 text-sm">
                    <Stat label="Runs (24h)" value={stats.total.toString()} />
                    <Stat
                      label="Success"
                      value={`${stats.ok}/${stats.total}`}
                      tone={stats.err > 0 ? "warn" : "ok"}
                    />
                    <Stat label="Errors (24h)" value={stats.err.toString()} tone={stats.err > 0 ? "err" : "ok"} />
                    <Stat label="Avg duration" value={`${(stats.avg_dur_ms / 1000).toFixed(1)}s`} />
                  </div>
                ) : (
                  <p className="mt-4 text-xs text-muted-foreground italic">
                    No runs recorded in the last 24h yet (cron history will
                    populate after the next fire).
                  </p>
                )}
              </div>

              <div>
                <h3 className="text-sm font-semibold mb-2">Last run</h3>
                {last ? (
                  <div className="space-y-2 text-sm">
                    <Row k="Started">
                      {fmtCST(last.startedAt)} — {fmtAgo(last.startedAt, nowMs)}
                    </Row>
                    <Row k="Finished">
                      {fmtCST(last.finishedAt)}
                    </Row>
                    <Row k="Duration">
                      {(last.durationMs / 1000).toFixed(1)}s
                    </Row>
                    <Row k="Status">
                      <span
                        className={
                          last.status === "ok"
                            ? "text-green-600 font-medium"
                            : "text-red-600 font-medium"
                        }
                      >
                        {last.status.toUpperCase()}
                      </span>
                    </Row>
                    {last.errorMessage ? (
                      <Row k="Error">
                        <code className="text-xs text-red-600 break-all whitespace-pre-wrap">
                          {last.errorMessage}
                        </code>
                      </Row>
                    ) : null}
                    {last.resultJson ? (
                      <details className="pt-2">
                        <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                          Result JSON
                        </summary>
                        <pre className="mt-2 text-xs bg-muted/40 p-3 rounded overflow-x-auto">
                          {JSON.stringify(last.resultJson, null, 2)}
                        </pre>
                      </details>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground italic">
                    Never run yet. Will appear after the first fire (or trigger
                    manually via curl + bearer token).
                  </p>
                )}
              </div>
            </div>

            {recent.length > 0 ? (
              <details className="border-t">
                <summary className="px-4 py-2 text-xs text-muted-foreground cursor-pointer hover:bg-muted/20">
                  Recent runs ({recent.length})
                </summary>
                <table className="w-full text-xs">
                  <thead className="bg-muted/30">
                    <tr>
                      <Th>Started (CST)</Th>
                      <Th>Status</Th>
                      <Th>Duration</Th>
                      <Th>Key counters</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((r, i) => (
                      <tr key={i} className="border-t">
                        <Td>{fmtCST(r.startedAt)}</Td>
                        <Td>
                          <span
                            className={
                              r.status === "ok"
                                ? "text-green-600"
                                : "text-red-600"
                            }
                          >
                            {r.status}
                          </span>
                        </Td>
                        <Td>{(r.durationMs / 1000).toFixed(1)}s</Td>
                        <Td className="font-mono">{summariseResult(r.resultJson)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-3">
      <span className="text-muted-foreground w-24 shrink-0">{k}</span>
      <span>{children}</span>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "err";
}) {
  const cls =
    tone === "err"
      ? "text-red-600"
      : tone === "warn"
        ? "text-amber-600"
        : "text-foreground";
  return (
    <div>
      <div className="text-[11px] uppercase text-muted-foreground tracking-wide">
        {label}
      </div>
      <div className={`text-lg font-semibold ${cls}`}>{value}</div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="text-left px-3 py-2 font-medium">{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-1.5 ${className ?? ""}`}>{children}</td>;
}

/** Pull the most informative counters out of result_json for compact display. */
function summariseResult(r: Record<string, unknown> | null): string {
  if (!r) return "—";
  const interesting = [
    "trades_fetched",
    "bets_placed",
    "signals_skipped",
    "duplicates_skipped",
    "positions_settled",
    "open_markets_seen",
    "open_markets_unique",
    "gamma_dupes_dropped",
    "matched_static_labels",
    "classified_via_llm",
    "upserted",
    "prices_updated",
    "open_position_cids",
    "clob_returned",
    "prices_missing",
  ];
  const parts: string[] = [];
  for (const k of interesting) {
    if (k in r && (r[k] as number) != null) parts.push(`${k}=${r[k]}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "(no counters)";
}
