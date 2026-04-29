// Live trade-event source: Polymarket data-api `/trades` endpoint.
//
// Why this module exists:
//   The Goldsky `orderbook-subgraph/0.0.1` indexer occasionally stalls — its
//   `_meta.block.timestamp` reports current chain head but the
//   `orderFilledEvents` table stops advancing for many hours. (Observed
//   2026-04-29: 34h+ stall while meta block was current.)
//
//   Polymarket's public REST data-api exposes `/trades` with sub-second
//   freshness, no auth required, and includes `conditionId` + `outcomeIndex`
//   + `side` + `price` + `size` + `timestamp` + `proxyWallet` + `txHash`
//   directly — we no longer need the token→market reverse lookup that the
//   raw Goldsky orderFilledEvent decoder required.
//
// This module returns `DecodedTrade[]` directly (skipping the goldsky decode
// step). The cron handler accepts both shapes — see `src/app/api/cron/poll`.
//
// Endpoint shape verified 2026-04-29:
//   GET https://data-api.polymarket.com/trades?fromTimestamp=<unix_s>&limit=500&offset=<n>
//   Response: array of trade rows, NEWEST-FIRST. To get all trades since
//   `fromTimestamp` we page with `offset` until <500 returned, then sort
//   ascending client-side.

import type { DecodedTrade } from "@/lib/goldsky";

const BASE = "https://data-api.polymarket.com";
const PAGE_SIZE = 500;

/** Raw shape returned by data-api /trades (only fields we use). */
type DataApiTrade = {
  proxyWallet: string;
  side: "BUY" | "SELL";
  asset: string; // numeric tokenId as string
  conditionId: string; // 0x... hex
  size: number; // outcome tokens (decimal)
  price: number; // 0..1
  timestamp: number; // unix seconds
  outcomeIndex: number; // 0 or 1
  transactionHash: string;
};

class TradesApiError extends Error {}

async function fetchPage(args: {
  fromTimestamp: number;
  offset: number;
  signal?: AbortSignal;
}): Promise<DataApiTrade[]> {
  const url =
    `${BASE}/trades?fromTimestamp=${args.fromTimestamp}` +
    `&limit=${PAGE_SIZE}&offset=${args.offset}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: args.signal,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new TradesApiError(
      `data-api /trades HTTP ${resp.status}: ${text.slice(0, 200)}`,
    );
  }
  const body = await resp.json();
  if (!Array.isArray(body)) {
    throw new TradesApiError(
      `data-api /trades unexpected body: ${JSON.stringify(body).slice(0, 200)}`,
    );
  }
  return body as DataApiTrade[];
}

/**
 * Fetch trades from Polymarket data-api newer than `sinceTs`.
 * Returns oldest -> newest, deduped by transactionHash + asset (defensive
 * against pagination boundary repeats).
 *
 * The default ceiling (`maxRows: 12000, maxPages: 25`) covers ~17 minutes of
 * trades at the observed peak rate (~700/min). At lower rates we exit early.
 */
export async function fetchTradesSinceFromDataApi(args: {
  sinceTs: number;
  maxRows?: number;
  maxPages?: number;
  signal?: AbortSignal;
}): Promise<DecodedTrade[]> {
  const { sinceTs, maxRows = 12000, maxPages = 25, signal } = args;

  const seen = new Set<string>();
  const collected: DataApiTrade[] = [];
  let offset = 0;
  let pages = 0;

  while (pages < maxPages && collected.length < maxRows) {
    const rows = await fetchPage({ fromTimestamp: sinceTs, offset, signal });
    if (rows.length === 0) break;
    for (const r of rows) {
      // dedupe key — txHash alone can repeat for multi-asset trades
      const key = `${r.transactionHash}:${r.asset}:${r.proxyWallet}:${r.timestamp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Defensive: only keep > sinceTs (data-api is `>=` and we don't want
      // to re-emit the sinceTs boundary trade).
      if (Number(r.timestamp) <= sinceTs) continue;
      collected.push(r);
    }
    pages += 1;
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  // Decode → strategy-shaped DecodedTrade. Side stays BUY/SELL (the strategy
  // evaluator handles both — `betOutcome = side === "BUY" ? outcomeIdx : 1 - outcomeIdx`).
  // Use a stable per-trade id we can dedupe on at the signals layer.
  const out: DecodedTrade[] = collected.map((r) => {
    const cid = String(r.conditionId).toLowerCase();
    const ts = Number(r.timestamp);
    // Polymarket can have multiple fills in the same tx (across outcomes/wallets).
    // Build a deterministic id that's unique across (tx, outcome, wallet, ts).
    const rawTradeId = `${r.transactionHash}-${r.outcomeIndex}-${r.proxyWallet.toLowerCase()}-${ts}`;
    const sizeOutcome = Number(r.size);
    const price = Number(r.price);
    return {
      rawTradeId,
      txHash: String(r.transactionHash),
      timestamp: ts,
      conditionId: cid,
      outcomeIdx: Number(r.outcomeIndex),
      side: r.side,
      price,
      sizeOutcome,
      // notionalUsd ≈ price * sizeOutcome (per-share-cost × shares).
      notionalUsd:
        Number.isFinite(price) && Number.isFinite(sizeOutcome)
          ? price * sizeOutcome
          : 0,
      wallet: String(r.proxyWallet).toLowerCase(),
      makerWallet: String(r.proxyWallet).toLowerCase(),
      takerWallet: String(r.proxyWallet).toLowerCase(),
    };
  });

  // Sort ascending by timestamp — required by the strategy/cron pipeline
  // (chronological cap=N + running-volume tracking).
  out.sort((a, b) => a.timestamp - b.timestamp);

  return out;
}
