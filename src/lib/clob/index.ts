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
  for (const t of tokens) {
    const outcome = String(t.outcome ?? "").toLowerCase();
    const p = Number(t.price);
    if (!Number.isFinite(p) || p < 0 || p > 1) continue;
    if (outcome === "yes") yesPrice = p;
    else if (outcome === "no") noPrice = p;
  }
  return {
    conditionId: String(data.condition_id ?? conditionId).toLowerCase(),
    question: typeof data.question === "string" ? data.question : null,
    yesPrice,
    noPrice,
    active: data.active === true,
    closed: data.closed === true,
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
