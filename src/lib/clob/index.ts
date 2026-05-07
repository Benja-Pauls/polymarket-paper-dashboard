// Polymarket CLOB API client — single-market lookup by condition_id.
//
// Why this exists alongside src/lib/gamma:
//   - Gamma's `?conditionIds=` filter does NOT actually filter the response
//     (verified 2026-05-04 — it returns the default page regardless). The
//     existing fetchMarketsByConditions in gamma/index.ts is broken; only
//     fetchOpenMarkets (which scans the full list) is reliable.
//   - CLOB's `/markets/<condition_id>` endpoint DOES filter — exact-match
//     by condition_id, returns one market with `tokens[]` containing live
//     prices. That's what we need for the refresh-position-prices cron
//     where we want prices for ~100 specific cids without paging 25K.
//
// The CLOB API is read-only and unauthenticated for these endpoints. Reachable
// from US clients (no geo-block, unlike Gamma's reported behavior).

const BASE = "https://clob.polymarket.com";

export type ClobMarket = {
  conditionId: string;
  question: string | null;
  /** Token-level prices. Index 0 = YES outcome, index 1 = NO. */
  yesPrice: number | null;
  noPrice: number | null;
  active: boolean;
  closed: boolean;
  /**
   * Winner outcome index, derived from `tokens[i].winner === true`.
   * 0 = YES won (resolved YES), 1 = NO won (resolved NO), null = unresolved.
   *
   * Only meaningful when `closed === true`. CLOB sets `tokens[i].winner` to
   * a boolean for every token on a resolved market; exactly one is true.
   * For open markets, the field is absent / always false → null returned.
   *
   * This is the AUTHORITATIVE resolution source. The settlement cron uses
   * it to decide payouts (which then become real-money credits when this
   * project is taken off paper). MUST stay accurate — see
   * src/app/api/cron/refresh-position-prices/route.ts for usage.
   */
  winnerOutcomeIdx: number | null;
  /**
   * Resolution timestamp from `accepting_order_timestamp` on closed markets,
   * or null. Best-effort — CLOB doesn't expose a clean "resolved at" field;
   * `accepting_orders=false` typically coincides with resolution and the
   * timestamp is a close proxy. Used only for display.
   */
  resolutionTimestamp: number | null;
};

/**
 * Fetch a single market's current state by condition_id. Returns null on
 * 404 or any error. Logs warnings; does NOT throw — callers want best-
 * effort semantics so one bad cid doesn't kill the whole refresh batch.
 */
export async function fetchClobMarket(
  conditionId: string,
  signal?: AbortSignal,
): Promise<ClobMarket | null> {
  const url = `${BASE}/markets/${encodeURIComponent(conditionId)}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal,
    });
  } catch (e) {
    console.warn(`[clob] fetch ${conditionId.slice(0, 10)} failed:`, (e as Error).message);
    return null;
  }
  if (resp.status === 404) return null;
  if (!resp.ok) {
    console.warn(`[clob] HTTP ${resp.status} on ${conditionId.slice(0, 10)}`);
    return null;
  }
  const data = (await resp.json()) as Record<string, unknown>;
  const tokens = Array.isArray(data.tokens) ? (data.tokens as Array<Record<string, unknown>>) : [];
  let yesPrice: number | null = null;
  let noPrice: number | null = null;
  // Track winner across both tokens. Exactly one should be true on a closed
  // market; if we somehow see two true (shouldn't happen) we treat as unresolved
  // to fail safe (better to wait for next cycle than settle wrong).
  let yesIsWinner = false;
  let noIsWinner = false;
  for (const t of tokens) {
    const outcome = String(t.outcome ?? "").toLowerCase();
    const p = Number(t.price);
    const isWinner = t.winner === true;
    if (Number.isFinite(p) && p >= 0 && p <= 1) {
      if (outcome === "yes") yesPrice = p;
      else if (outcome === "no") noPrice = p;
    }
    if (outcome === "yes" && isWinner) yesIsWinner = true;
    else if (outcome === "no" && isWinner) noIsWinner = true;
  }

  // Derive winner index. ONLY assign a winner if exactly one token is marked
  // (defensive against malformed responses or markets in a transitional state).
  let winnerOutcomeIdx: number | null = null;
  if (yesIsWinner && !noIsWinner) winnerOutcomeIdx = 0;
  else if (noIsWinner && !yesIsWinner) winnerOutcomeIdx = 1;

  // CLOB doesn't have an explicit "resolved_at" field. accepting_order_timestamp
  // is the closest proxy on closed markets — when the orderbook stops accepting
  // new orders, that's effectively the resolution moment. Best-effort.
  let resolutionTimestamp: number | null = null;
  if (data.closed === true && typeof data.accepting_order_timestamp === "string") {
    const ts = Date.parse(data.accepting_order_timestamp);
    if (Number.isFinite(ts)) resolutionTimestamp = Math.floor(ts / 1000);
  }

  return {
    conditionId: String(data.condition_id ?? conditionId).toLowerCase(),
    question: typeof data.question === "string" ? data.question : null,
    yesPrice,
    noPrice,
    active: data.active === true,
    closed: data.closed === true,
    winnerOutcomeIdx,
    resolutionTimestamp,
  };
}

/**
 * Fetch many markets concurrently. Caps at `concurrency` simultaneous
 * requests to avoid spamming CLOB. Failed individual lookups silently
 * drop out of the result map.
 */
export async function fetchClobMarketsBatch(args: {
  conditionIds: string[];
  concurrency?: number;
  signal?: AbortSignal;
}): Promise<Map<string, ClobMarket>> {
  const { conditionIds, concurrency = 8, signal } = args;
  const out = new Map<string, ClobMarket>();
  const queue = [...new Set(conditionIds.filter(Boolean))];
  const inflight: Promise<void>[] = [];
  while (queue.length > 0 || inflight.length > 0) {
    while (inflight.length < concurrency && queue.length > 0) {
      const cid = queue.shift()!;
      const p = fetchClobMarket(cid, signal).then((m) => {
        if (m) out.set(m.conditionId.toLowerCase(), m);
      });
      inflight.push(p);
      // Remove from inflight when done.
      p.finally(() => {
        const i = inflight.indexOf(p);
        if (i >= 0) inflight.splice(i, 1);
      });
    }
    if (inflight.length > 0) {
      await Promise.race(inflight);
    }
  }
  return out;
}
