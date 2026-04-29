// Thin GraphQL client over Polymarket's Goldsky-hosted subgraphs.
//
// Polymarket's REST APIs are Cloudflare geo-blocked from the US, but their
// on-chain trade data is public via Goldsky subgraphs. This module wraps
// the live `orderbook` subgraph for new-trade polling.
//
// Notes:
//   - The `orderbook_resync` subgraph is FROZEN as of ~Jan 5 2026 — do NOT
//     use it for live polling. Use `orderbook` instead.
//   - The schema differs across subgraphs:
//       orderbook         entity = orderFilledEvents (live)
//       orderbook_resync  entity = orderFilledEvents (historical, frozen)

const PROJECT_ID =
  process.env.GOLDSKY_PROJECT_ID || "project_cl6mb8i9h0003e201j6li0diw";
const BASE = `https://api.goldsky.com/api/public/${PROJECT_ID}/subgraphs`;

export const SUBGRAPHS = {
  orderbook: `${BASE}/orderbook-subgraph/0.0.1/gn`,
  orderbook_resync: `${BASE}/polymarket-orderbook-resync/prod/gn`,
  activity: `${BASE}/activity-subgraph/0.0.4/gn`,
  pnl: `${BASE}/pnl-subgraph/0.0.14/gn`,
  oi: `${BASE}/oi-subgraph/0.0.6/gn`,
  positions: `${BASE}/positions-subgraph/0.0.7/gn`,
} as const;

export type SubgraphName = keyof typeof SUBGRAPHS;

const USDC_SCALE = 1_000_000;
const PAGE_SIZE = 1000;

export type RawOrderFilledEvent = {
  id: string;
  transactionHash: string;
  timestamp: string; // unix seconds as string
  maker: string;
  taker: string;
  makerAssetId: string; // token id; "0" = USDC
  takerAssetId: string;
  makerAmountFilled: string;
  takerAmountFilled: string;
  fee?: string;
};

/** Decoded trade in the format the strategy understands. */
export type DecodedTrade = {
  rawTradeId: string;
  txHash: string;
  timestamp: number;
  conditionId: string;
  outcomeIdx: number; // 0 or 1
  side: "BUY" | "SELL";
  price: number; // 0..1
  sizeOutcome: number; // # tokens in YES units
  notionalUsd: number;
  wallet: string; // the trader (maker if maker-side, taker if taker-side)
  makerWallet: string;
  takerWallet: string;
};

class GoldskyError extends Error {}

async function gqlPost(
  url: string,
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal,
    cache: "no-store",
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new GoldskyError(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const body = (await resp.json()) as {
    data?: unknown;
    errors?: Array<{ message: string }>;
  };
  if (body.errors && body.errors.length > 0) {
    throw new GoldskyError(`GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  return body.data;
}

/**
 * Fetch new orderFilledEvents since a timestamp. Pages internally.
 * Returns oldest -> newest.
 */
export async function fetchTradesSince(args: {
  sinceTs: number;
  maxRows?: number;
  maxPages?: number;
  signal?: AbortSignal;
}): Promise<RawOrderFilledEvent[]> {
  const { sinceTs, maxRows = 5000, maxPages = 6, signal } = args;
  const url = SUBGRAPHS.orderbook;

  const fields =
    "id transactionHash timestamp orderHash maker taker " +
    "makerAssetId takerAssetId makerAmountFilled takerAmountFilled fee";

  let cursor = sinceTs;
  let pages = 0;
  const out: RawOrderFilledEvent[] = [];
  // Avoid duplicates if a trade lands on a page boundary with the same ts.
  const seenIds = new Set<string>();

  while (pages < maxPages && out.length < maxRows) {
    const query = `query Page($first: Int!, $cursor: BigInt!) {
      items: orderFilledEvents(
        first: $first,
        orderBy: timestamp,
        orderDirection: asc,
        where: { timestamp_gt: $cursor }
      ) { ${fields} }
    }`;
    const data = (await gqlPost(
      url,
      query,
      { first: PAGE_SIZE, cursor: String(cursor) },
      signal,
    )) as { items?: RawOrderFilledEvent[] };
    const rows = data?.items || [];
    if (rows.length === 0) break;
    let advanced = false;
    for (const r of rows) {
      if (seenIds.has(r.id)) continue;
      seenIds.add(r.id);
      out.push(r);
      const ts = Number(r.timestamp);
      if (Number.isFinite(ts) && ts > cursor) {
        cursor = ts;
        advanced = true;
      }
    }
    pages += 1;
    if (rows.length < PAGE_SIZE) break;
    if (!advanced) break; // can't make progress; bail
  }
  return out;
}

/**
 * Fetch a market's resolution metadata from `orderbook_resync.condition`.
 * That subgraph froze around Jan 5 2026 — markets created BEFORE that date
 * are present, markets created AFTER are not. For frozen markets we get
 * `resolutionTimestamp`, `payouts`, and the winner.
 *
 * For post-freeze markets we fall back to scanning `activity-subgraph`
 * Redemption events; presence of any redemption implies resolution.
 */
export async function fetchMarketMetadata(args: {
  conditionId: string;
  signal?: AbortSignal;
}): Promise<{
  resolutionTimestamp: number | null;
  payouts: string[] | null;
  winnerOutcomeIdx: number | null;
} | null> {
  // Primary: orderbook_resync.condition has resolutionTimestamp + payouts.
  const q1 = `query Cond($id: ID!) {
    condition(id: $id) {
      id
      resolutionTimestamp
      payouts
      outcomeSlotCount
      payoutDenominator
    }
  }`;
  let resTs: number | null = null;
  let payouts: string[] | null = null;
  let winner: number | null = null;
  try {
    const data = (await gqlPost(SUBGRAPHS.orderbook_resync, q1, { id: args.conditionId }, args.signal)) as
      | {
          condition?: {
            id: string;
            resolutionTimestamp?: string | null;
            payouts?: string[] | null;
            payoutDenominator?: string | null;
          } | null;
        }
      | null;
    const c = data?.condition;
    if (c) {
      resTs = c.resolutionTimestamp != null ? Number(c.resolutionTimestamp) : null;
      payouts = c.payouts ?? null;
      if (payouts && payouts.length >= 2) {
        for (let i = 0; i < payouts.length; i++) {
          const v = Number(payouts[i]);
          if (Number.isFinite(v) && v > 0.5) {
            winner = i;
            break;
          }
        }
      }
    }
  } catch {
    // continue to fallback
  }

  // Fallback: activity-subgraph Redemption (resolution timestamp + payout)
  if (resTs == null || winner == null) {
    const q2 = `query Red($cond: String!) {
      redemptions(first: 1, where: { condition: $cond }, orderBy: timestamp, orderDirection: asc) {
        timestamp
        payout
      }
    }`;
    try {
      const d2 = (await gqlPost(SUBGRAPHS.activity, q2, { cond: args.conditionId }, args.signal)) as {
        redemptions?: Array<{ timestamp: string; payout: string }>;
      } | null;
      const r = d2?.redemptions?.[0];
      if (r) {
        const ts = Number(r.timestamp);
        if (Number.isFinite(ts) && ts > 0 && resTs == null) resTs = ts;
        // We can't determine winner outcome from a single redemption alone
        // (it's per-redeemer). Leave winner null; settlement will retry.
      }
    } catch {
      // give up
    }
  }

  if (resTs == null && payouts == null && winner == null) return null;

  return {
    resolutionTimestamp: resTs && Number.isFinite(resTs) && resTs > 0 ? resTs : null,
    payouts,
    winnerOutcomeIdx: winner,
  };
}

/**
 * Batched fetch of resolution metadata for many condition_ids.
 * Returns map of conditionId -> {resolutionTimestamp, payouts, winnerOutcomeIdx}.
 */
export async function fetchMarketMetadataBatch(args: {
  conditionIds: string[];
  signal?: AbortSignal;
}): Promise<
  Map<
    string,
    {
      resolutionTimestamp: number | null;
      payouts: string[] | null;
      winnerOutcomeIdx: number | null;
    }
  >
> {
  const out = new Map<
    string,
    {
      resolutionTimestamp: number | null;
      payouts: string[] | null;
      winnerOutcomeIdx: number | null;
    }
  >();
  const unique = Array.from(new Set(args.conditionIds.filter(Boolean)));
  if (unique.length === 0) return out;

  const CHUNK = 100;
  const q = `query Conds($ids: [ID!]!) {
    conditions(first: 1000, where: { id_in: $ids }) {
      id
      resolutionTimestamp
      payouts
    }
  }`;

  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    try {
      const data = (await gqlPost(
        SUBGRAPHS.orderbook_resync,
        q,
        { ids: batch },
        args.signal,
      )) as {
        conditions?: Array<{
          id: string;
          resolutionTimestamp?: string | null;
          payouts?: string[] | null;
        }>;
      } | null;
      for (const c of data?.conditions ?? []) {
        const resTs = c.resolutionTimestamp != null ? Number(c.resolutionTimestamp) : null;
        let winner: number | null = null;
        if (c.payouts && c.payouts.length >= 2) {
          for (let j = 0; j < c.payouts.length; j++) {
            const v = Number(c.payouts[j]);
            if (Number.isFinite(v) && v > 0.5) {
              winner = j;
              break;
            }
          }
        }
        out.set(String(c.id), {
          resolutionTimestamp: resTs && Number.isFinite(resTs) && resTs > 0 ? resTs : null,
          payouts: c.payouts ?? null,
          winnerOutcomeIdx: winner,
        });
      }
    } catch {
      // tolerate
    }
  }
  return out;
}

/**
 * Reverse-lookup: given a token id (positionId), find its conditionId and
 * outcome index. Uses the orderbook subgraph's `MarketData` entity.
 */
export async function fetchMarketForToken(args: {
  tokenId: string;
  signal?: AbortSignal;
}): Promise<{
  conditionId: string;
  outcomeIdx: number;
} | null> {
  const out = await fetchMarketsForTokens({
    tokenIds: [args.tokenId],
    signal: args.signal,
  });
  return out.get(args.tokenId) ?? null;
}

/**
 * Batched reverse-lookup: many token ids -> map of token -> {conditionId, outcomeIdx}.
 * Pages in chunks of 100 (Goldsky's _in filter limit).
 *
 * Tries the live `orderbook` subgraph first, then falls back to the frozen
 * `orderbook_resync` for any unresolved tokens.
 */
export async function fetchMarketsForTokens(args: {
  tokenIds: string[];
  signal?: AbortSignal;
}): Promise<Map<string, { conditionId: string; outcomeIdx: number }>> {
  const result = new Map<string, { conditionId: string; outcomeIdx: number }>();
  const unique = Array.from(new Set(args.tokenIds.filter(Boolean)));
  if (unique.length === 0) return result;

  const CHUNK = 100;
  const q = `query Tok($ids: [ID!]!) {
    marketDatas(first: 1000, where: { id_in: $ids }) {
      id
      condition
      outcomeIndex
    }
  }`;

  async function batchOn(url: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      const data = (await gqlPost(url, q, { ids }, args.signal)) as {
        marketDatas?: Array<{
          id: string;
          condition?: string | null;
          outcomeIndex?: string | null;
        }>;
      } | null;
      for (const m of data?.marketDatas ?? []) {
        if (!m.id || !m.condition) continue;
        const idx = Number(m.outcomeIndex ?? "-1");
        if (!Number.isFinite(idx) || idx < 0) continue;
        result.set(String(m.id), { conditionId: m.condition, outcomeIdx: idx });
      }
    } catch {
      // partial failures are ok; missing tokens will be skipped downstream
    }
  }

  // Round 1: live orderbook subgraph
  for (let i = 0; i < unique.length; i += CHUNK) {
    await batchOn(SUBGRAPHS.orderbook, unique.slice(i, i + CHUNK));
  }
  // Round 2: orderbook_resync for tokens we didn't find
  const missing = unique.filter((t) => !result.has(t));
  for (let i = 0; i < missing.length; i += CHUNK) {
    await batchOn(SUBGRAPHS.orderbook_resync, missing.slice(i, i + CHUNK));
  }
  return result;
}

/**
 * Decode a raw OrderFilledEvent into a normalized trade we can score.
 * Returns null if the trade can't be mapped to a known market token.
 */
export function decodeTrade(
  raw: RawOrderFilledEvent,
  tokenToMarket: Map<string, { conditionId: string; outcomeIdx: number }>,
): DecodedTrade | null {
  const makerAsset = String(raw.makerAssetId);
  const takerAsset = String(raw.takerAssetId);
  let makerAmt: number;
  let takerAmt: number;
  try {
    makerAmt = Number(BigInt(raw.makerAmountFilled));
    takerAmt = Number(BigInt(raw.takerAmountFilled));
  } catch {
    return null;
  }
  if (!Number.isFinite(makerAmt) || !Number.isFinite(takerAmt)) return null;

  let tokenId: string;
  let sizeOutcomeRaw: number;
  let usdRaw: number;
  let buyerRole: "maker" | "taker";

  if (makerAsset === "0") {
    // Maker gave USDC, taker received outcome tokens -> taker bought
    tokenId = takerAsset;
    sizeOutcomeRaw = takerAmt;
    usdRaw = makerAmt;
    buyerRole = "taker";
  } else if (takerAsset === "0") {
    // Maker gave outcome tokens, received USDC -> maker sold (taker bought USDC)
    tokenId = makerAsset;
    sizeOutcomeRaw = makerAmt;
    usdRaw = takerAmt;
    buyerRole = "maker";
  } else {
    // Outcome-vs-outcome trade (rare); skip for now
    return null;
  }

  const market = tokenToMarket.get(tokenId);
  if (!market) return null;

  const sizeOutcome = sizeOutcomeRaw / USDC_SCALE;
  if (sizeOutcome <= 0) return null;
  const usd = usdRaw / USDC_SCALE;
  const price = usd / sizeOutcome;

  // The "trader" we track is whichever party brought outcome tokens or USDC.
  // For copy-trade signaling we use the BUYER's wallet, since BUY is the
  // canonical side we score.
  const buyerWallet = buyerRole === "taker" ? raw.taker : raw.maker;
  const side: "BUY" | "SELL" = "BUY"; // we represent every trade as a BUY of `outcomeIdx` at `price`

  return {
    rawTradeId: raw.id,
    txHash: raw.transactionHash,
    timestamp: Number(raw.timestamp),
    conditionId: market.conditionId,
    outcomeIdx: market.outcomeIdx,
    side,
    price,
    sizeOutcome,
    notionalUsd: usd,
    wallet: buyerWallet,
    makerWallet: raw.maker,
    takerWallet: raw.taker,
  };
}
