// Persistent record of every cron-job invocation.
//
// Each cron handler wraps its work in `recordCronRun()` so we get a row in
// the `cron_runs` table at the end of every fire — successful or failed. The
// /admin/crons page reads from this to surface "what ran when, what did it
// return, how long did it take" without operators having to dig through
// Vercel logs.
//
// Why a wrapper instead of a middleware: Vercel cron handlers are plain
// route handlers; we want one writeable scope per invocation, with structured
// status/error capture and timing — easiest done as an inline wrapper.

import { db } from "@/lib/db";
import { cronRuns } from "@/lib/db/schema";

// Drizzle's error message format is "Failed query: <SQL>\nparams: <values>\n<actual postgres error reason>".
// At 1000 chars we never see the postgres reason — just truncated SQL. Bump to
// 8000 so we capture the entire chain. Errors are rare enough that the row
// size doesn't matter for the cron_runs table.
//
// 8000 chars is STILL not enough for some queries — the sync-open-markets
// bulk upsert with BATCH=200 produces SQL longer than 8000 chars all by
// itself, so the postgres reason at the END of the message gets sliced off.
// Solution: pull the structured Postgres error fields (code, detail, hint,
// severity, constraint) off the error object and PREPEND them to the
// captured message, so the actual diagnosis lives at character 0 and
// survives the slice no matter how long the SQL is.
const MAX_ERROR_MSG = 8000;

/**
 * Build a single error string with the Postgres structured fields prepended,
 * so even if the trailing SQL/params section is sliced off we still capture
 * the actual reason. Drizzle wraps the original pg error in `cause`; we
 * inspect both the outer error and the inner cause.
 */
function formatError(e: unknown): string {
  const err = e as Error & {
    code?: string;
    detail?: string;
    hint?: string;
    severity?: string;
    where?: string;
    constraint?: string;
    table?: string;
    column?: string;
    routine?: string;
    cause?: unknown;
  };

  // The Postgres-side fields (`code`, `detail`, `hint`, etc.) usually live on
  // err.cause when Drizzle wraps the error; fall back to the outer object if
  // there's no cause.
  const pg = (err.cause ?? err) as typeof err;

  const meta: string[] = [];
  if (pg.code) meta.push(`code=${pg.code}`);
  if (pg.severity) meta.push(`severity=${pg.severity}`);
  if (pg.constraint) meta.push(`constraint=${pg.constraint}`);
  if (pg.table) meta.push(`table=${pg.table}`);
  if (pg.column) meta.push(`column=${pg.column}`);
  if (pg.routine) meta.push(`routine=${pg.routine}`);
  if (pg.detail) meta.push(`detail=${pg.detail}`);
  if (pg.hint) meta.push(`hint=${pg.hint}`);
  if (pg.where) meta.push(`where=${pg.where.slice(0, 200)}`);

  // If cause itself has a message (and it's different from the outer one),
  // include that too — it's where pg drivers like to put "connection
  // terminated unexpectedly" / "Connection terminated due to connection
  // timeout" etc.
  const causeMsg =
    err.cause && (err.cause as Error).message && (err.cause as Error).message !== err.message
      ? (err.cause as Error).message
      : null;

  const prefix = meta.length > 0 ? `[${meta.join(" | ")}] ` : "";
  const causePart = causeMsg ? `cause: ${causeMsg} :: ` : "";
  const baseMessage = err.message ?? String(err);

  return prefix + causePart + baseMessage;
}

/**
 * Wrap a cron handler's body. The wrapper:
 *   1. Records start time.
 *   2. Calls `fn()` and captures its result OR error.
 *   3. Inserts one row into cron_runs with the outcome.
 *   4. Re-throws on error so the route handler can return its 500.
 *
 * Logging is best-effort — if the cron_runs INSERT itself fails (e.g. the
 * database is down), we log the failure to console and let the original
 * function's outcome flow through. We never let observability infra take
 * down a working cron.
 */
export async function recordCronRun<T>(
  cronName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = new Date();
  let result: T | null = null;
  let errorMessage: string | null = null;
  try {
    result = await fn();
    return result;
  } catch (e) {
    errorMessage = formatError(e).slice(0, MAX_ERROR_MSG);
    throw e;
  } finally {
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    try {
      await db.insert(cronRuns).values({
        cronName,
        startedAt,
        finishedAt,
        durationMs,
        status: errorMessage ? "error" : "ok",
        resultJson:
          result && typeof result === "object"
            ? (result as unknown as Record<string, unknown>)
            : null,
        errorMessage,
      });
    } catch (insertErr) {
      console.error(
        `[cron-tracker] failed to log run for ${cronName}:`,
        (insertErr as Error).message,
      );
    }
  }
}
