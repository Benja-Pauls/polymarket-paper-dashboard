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

const MAX_ERROR_MSG = 1000;

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
    errorMessage = ((e as Error)?.message ?? String(e)).slice(0, MAX_ERROR_MSG);
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
