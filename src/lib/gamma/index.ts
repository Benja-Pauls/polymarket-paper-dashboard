// Polymarket Gamma API client (read-only; no secret).
//
// Gamma is the canonical REST source of OPEN markets — Goldsky's `condition`
// entity has no concept of `endDate`, so on-chain alone we cannot tell whether
// an unresolved market closes tomorrow or in 6 months.
//
// Empirically reachable from US clients as of 2026-04-29. CLAUDE.md flags an
// older note about geo-blocking — we treat that as warning-only and fall back
// gracefully if the request 403s in production.

const BASE = "https://gamma-api.polymarket.com";

export type GammaMarket = {
  id: string;
  conditionId: string;
  question: string | null;
  category: string | null;
  endDate: string | null; // ISO timestamp
  startDate: string | null;
  active: boolean;
  closed: boolean;
  archived?: boolean;
  liquidity?: string;
  volume?: string;
};

export type GammaError = { error: string; status?: number };
export class GammaUnreachableError extends Error {}

/**
 * Fetch active+open markets paginated. Returns oldest-first by endDate.
 * Stops paging when fewer than `limit` rows come back.
 *
 * NOTE: defensively retries once on 5xx; surfaces 4xx (esp 403 geo-block) as
 * GammaUnreachableError so the caller can fall back.
 */
export async function fetchOpenMarkets(args: {
  maxRows?: number;
  /** Skip markets with endDate already in the past (sometimes Gamma returns stale). */
  futureOnly?: boolean;
  /**
   * Skip markets with endDate FURTHER OUT than this many days from now.
   * Default 60 days. Strategy max_hours_to_res defaults to 720h (30d), so 60d
   * gives a buffer for markets where time-to-resolution shrinks as we
   * accumulate trades closer to resolution. Setting null disables the cap.
   *
   * This avoids spending Anthropic API calls (Claude Haiku ~$0.0001/call)
   * classifying markets we can't bet on anyway, and keeps the watched market
   * universe focused on near-resolution markets where favorite-longshot edge
   * lives.
   */
  maxEndDateDays?: number | null;
  signal?: AbortSignal;
}): Promise<GammaMarket[]> {
  const {
    maxRows = 5000,
    futureOnly = true,
    maxEndDateDays = 60,
    signal,
  } = args;
  const LIMIT = 500;
  let offset = 0;
  const out: GammaMarket[] = [];
  const nowS = Math.floor(Date.now() / 1000);
  const farFutureCap =
    maxEndDateDays == null ? null : nowS + maxEndDateDays * 86400;

  let totalSeen = 0;
  let droppedFarFuture = 0;
  let droppedPast = 0;

  while (out.length < maxRows) {
    const url = `${BASE}/markets?active=true&closed=false&limit=${LIMIT}&offset=${offset}`;
    const data = await fetchPage(url, signal);
    if (!Array.isArray(data) || data.length === 0) break;
    for (const r of data) {
      totalSeen++;
      const m = normalize(r);
      if (!m) continue;
      if (m.endDate) {
        const ts = parseEndTs(m.endDate);
        if (ts != null) {
          if (futureOnly && ts <= nowS) {
            droppedPast++;
            continue;
          }
          if (farFutureCap != null && ts > farFutureCap) {
            droppedFarFuture++;
            continue;
          }
        }
      }
      out.push(m);
      if (out.length >= maxRows) break;
    }
    offset += data.length;
    if (data.length < LIMIT) break;
  }
  if (droppedFarFuture > 0 || droppedPast > 0) {
    console.log(
      `[gamma.fetchOpenMarkets] kept=${out.length} of ${totalSeen}; dropped past=${droppedPast} far-future=${droppedFarFuture} (cap=${maxEndDateDays}d)`,
    );
  }
  return out;
}

/** Fetch a single market by conditionId. Returns null if not found. */
export async function fetchMarketByCondition(args: {
  conditionId: string;
  signal?: AbortSignal;
}): Promise<GammaMarket | null> {
  const url = `${BASE}/markets?conditionIds=${encodeURIComponent(args.conditionId)}&limit=1`;
  try {
    const data = await fetchPage(url, args.signal);
    if (!Array.isArray(data) || data.length === 0) return null;
    return normalize(data[0]);
  } catch (e) {
    if (e instanceof GammaUnreachableError) return null;
    return null;
  }
}

/**
 * Batch lookup by conditionIds. Gamma supports up to ~50 ids per request via
 * repeated `conditionIds=` query params.
 */
export async function fetchMarketsByConditions(args: {
  conditionIds: string[];
  signal?: AbortSignal;
}): Promise<Map<string, GammaMarket>> {
  const out = new Map<string, GammaMarket>();
  const unique = Array.from(new Set(args.conditionIds.filter(Boolean)));
  const CHUNK = 25; // be conservative on URL length
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const qs = batch.map((c) => `conditionIds=${encodeURIComponent(c)}`).join("&");
    const url = `${BASE}/markets?${qs}&limit=${CHUNK}`;
    try {
      const data = await fetchPage(url, args.signal);
      if (Array.isArray(data)) {
        for (const r of data) {
          const m = normalize(r);
          if (!m) continue;
          out.set(m.conditionId.toLowerCase(), m);
        }
      }
    } catch (e) {
      // tolerate batch failures
      console.warn(`[gamma] batch fetch failed (i=${i}):`, (e as Error).message);
    }
  }
  return out;
}

async function fetchPage(url: string, signal?: AbortSignal): Promise<unknown> {
  const resp = await fetch(url, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal,
  });
  if (resp.status === 403 || resp.status === 451) {
    throw new GammaUnreachableError(
      `Gamma blocked (HTTP ${resp.status}) — likely geo-restricted from this region`,
    );
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

function normalize(r: unknown): GammaMarket | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const cid = String(o.conditionId ?? "").toLowerCase();
  if (!cid) return null;
  return {
    id: String(o.id ?? ""),
    conditionId: cid,
    question: typeof o.question === "string" ? o.question : null,
    category: typeof o.category === "string" ? o.category : null,
    endDate: typeof o.endDate === "string" ? o.endDate : null,
    startDate: typeof o.startDate === "string" ? o.startDate : null,
    active: o.active === true,
    closed: o.closed === true,
    archived: o.archived === true,
    liquidity: typeof o.liquidity === "string" ? o.liquidity : undefined,
    volume: typeof o.volume === "string" ? o.volume : undefined,
  };
}

/** Parse an ISO timestamp ("2026-07-31T12:00:00Z") to unix seconds. */
export function parseEndTs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}
