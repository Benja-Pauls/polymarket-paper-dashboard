// Formatting helpers used across the UI. All time-formatting funcs default to
// America/Chicago (CST/CDT) — that's the operator's local zone and the
// canonical reference for "when did the cron last run" displays.

const ZONE = "America/Chicago";

export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export function fmtUsdSigned(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  const abs = Math.abs(n);
  if (abs >= 1000) return `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

export function fmtPrice(n: number | null | undefined, digits = 3): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

/**
 * Compact CST timestamp from a unix-seconds value. "Apr 29 5:55 PM" — defaults
 * to America/Chicago, no year, no zone suffix (caller can append " CST" if
 * they want; we omit because it's the dashboard-wide default).
 */
export function fmtTs(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) return "—";
  const d = new Date(ts * 1000);
  return d.toLocaleString("en-US", {
    timeZone: ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** Same as fmtTs but accepts a Date / number-ms / ISO string instead of unix-s. */
export function fmtCST(input: Date | number | string | null | undefined): string {
  if (input == null) return "—";
  let d: Date;
  if (input instanceof Date) d = input;
  else if (typeof input === "number") d = new Date(input < 1e12 ? input * 1000 : input);
  else d = new Date(input);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    timeZone: ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
}

export function fmtDate(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) return "—";
  // Date in CST (so a 11pm CST Apr 29 record shows as "Apr 29", not "Apr 30" UTC).
  const d = new Date(ts * 1000);
  return d.toLocaleDateString("en-CA", { timeZone: ZONE }); // YYYY-MM-DD form
}

/**
 * "5m ago" / "2h 14m ago" / "3d 4h ago" — relative age. Caller supplies
 * `nowMs` to keep SSR + hydration in sync (otherwise renders drift).
 */
export function fmtAgo(
  input: Date | number | string | null | undefined,
  nowMs: number = Date.now(),
): string {
  if (input == null) return "—";
  let d: Date;
  if (input instanceof Date) d = input;
  else if (typeof input === "number") d = new Date(input < 1e12 ? input * 1000 : input);
  else d = new Date(input);
  if (!Number.isFinite(d.getTime())) return "—";
  const deltaMs = nowMs - d.getTime();
  if (deltaMs < 0) return fmtCountdown(d, nowMs);
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ${hr % 24}h ago`;
}

/**
 * "in 5m 12s" / "in 2h 14m" — countdown to a future timestamp. Returns "now"
 * when the target is past (caller should treat the cron as overdue).
 */
export function fmtCountdown(
  target: Date | number | string | null | undefined,
  nowMs: number = Date.now(),
): string {
  if (target == null) return "—";
  let d: Date;
  if (target instanceof Date) d = target;
  else if (typeof target === "number") d = new Date(target < 1e12 ? target * 1000 : target);
  else d = new Date(target);
  if (!Number.isFinite(d.getTime())) return "—";
  const deltaSec = Math.floor((d.getTime() - nowMs) / 1000);
  if (deltaSec <= 0) return "now";
  if (deltaSec < 60) return `in ${deltaSec}s`;
  const min = Math.floor(deltaSec / 60);
  const sec = deltaSec % 60;
  if (min < 60) return `in ${min}m ${sec}s`;
  const hr = Math.floor(min / 60);
  const minRem = min % 60;
  if (hr < 24) return `in ${hr}h ${minRem}m`;
  const day = Math.floor(hr / 24);
  return `in ${day}d ${hr % 24}h`;
}

/**
 * Compute the next fire time for a Vercel cron expression — limited subset
 * matching the patterns we actually use:
 *   - "*\/N * * * *"    every N minutes
 *   - "M *\/N * * *"    every N hours, at minute M
 *   - "M H * * *"      every day at H:M UTC
 * Returns null for unsupported patterns (caller should just hide the
 * countdown rather than show a wrong one).
 */
export function nextCronFire(
  expr: string,
  nowMs: number = Date.now(),
): Date | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, mon, dow] = parts;
  if (dom !== "*" || mon !== "*" || dow !== "*") return null;

  const now = new Date(nowMs);
  const next = new Date(now);
  next.setUTCSeconds(0);
  next.setUTCMilliseconds(0);

  const everyNMin = /^\*\/(\d+)$/.exec(minute);
  if (everyNMin && hour === "*") {
    const N = Math.max(1, parseInt(everyNMin[1], 10));
    const curMin = now.getUTCMinutes();
    const nextMin = Math.ceil((curMin + 1) / N) * N;
    if (nextMin >= 60) {
      next.setUTCHours(now.getUTCHours() + 1);
      next.setUTCMinutes(0);
    } else {
      next.setUTCMinutes(nextMin);
    }
    return next;
  }

  const everyNHr = /^\*\/(\d+)$/.exec(hour);
  const fixedMin = /^\d+$/.test(minute) ? parseInt(minute, 10) : null;
  if (everyNHr && fixedMin != null) {
    const N = Math.max(1, parseInt(everyNHr[1], 10));
    const curHr = now.getUTCHours();
    let candHr: number;
    if (curHr % N === 0 && now.getUTCMinutes() < fixedMin) {
      candHr = curHr;
    } else {
      candHr = Math.ceil((curHr + 1) / N) * N;
    }
    if (candHr >= 24) {
      next.setUTCDate(now.getUTCDate() + 1);
      next.setUTCHours(0);
    } else {
      next.setUTCHours(candHr);
    }
    next.setUTCMinutes(fixedMin);
    return next;
  }

  // Fixed-time daily: "M H * * *"
  if (fixedMin != null && /^\d+$/.test(hour)) {
    const H = parseInt(hour, 10);
    next.setUTCHours(H);
    next.setUTCMinutes(fixedMin);
    if (next.getTime() <= now.getTime()) {
      next.setUTCDate(now.getUTCDate() + 1);
    }
    return next;
  }

  return null;
}

export function shortCid(cid: string | null | undefined, n = 8): string {
  if (!cid) return "—";
  return `${cid.slice(0, 2 + n)}…${cid.slice(-4)}`;
}

export function shortAddr(addr: string | null | undefined, n = 6): string {
  if (!addr) return "—";
  return `${addr.slice(0, 2 + n)}…${addr.slice(-4)}`;
}
