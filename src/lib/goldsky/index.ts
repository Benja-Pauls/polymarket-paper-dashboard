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
 * Fetch a market's metadata from the activity subgraph by condition_id.
 * Returns resolution_timestamp, payouts (set when resolved), and the
 * token_to_outcome map.
 */
export async function fetchMarketMetadata(args: {
  conditionId: string;
  signal?: AbortSignal;
}): Promise<{
  resolutionTimestamp: number | null;
  payouts: string[] | null;
  winnerOutcomeIdx: number | null;
  tokenToOutcome: Record<string, number>;
} | null> {
  const url = SUBGRAPHS.activity;
  const query = `query Cond($id: ID!) {
    condition(id: $id) {
      id
      resolutionTimestamp
      payouts
      outcomeSlotCount
      positionIds
    }
  }`;
  const data = (await gqlPost(url, query, { id: args.conditionId.toLowerCase() }, args.signal)) as
    | {
        condition?: {
          id: string;
          resolutionTimestamp?: string | null;
          payouts?: string[] | null;
          outcomeSlotCount?: number | null;
          positionIds?: string[] | null;
        } | null;
      }
    | null;
  const c = data?.condition;
  if (!c) return null;

  const resTs = c.resolutionTimestamp != null ? Number(c.resolutionTimestamp) : null;
  const payouts = c.payouts ?? null;
  let winner: number | null = null;
  if (payouts && payouts.length >= 2) {
    for (let i = 0; i < payouts.length; i++) {
      const v = Number(payouts[i]);
      if (Number.isFinite(v) && v > 0.5) {
        winner = i;
        break;
      }
    }
  }

  // positionIds is the list of token IDs in outcome order: [YES_token, NO_token].
  const tokenToOutcome: Record<string, number> = {};
  if (c.positionIds && Array.isArray(c.positionIds)) {
    c.positionIds.forEach((tid, idx) => {
      if (tid) tokenToOutcome[String(tid)] = idx;
    });
  }

  return {
    resolutionTimestamp: resTs && Number.isFinite(resTs) && resTs > 0 ? resTs : null,
    payouts,
    winnerOutcomeIdx: winner,
    tokenToOutcome,
  };
}

/**
 * Reverse-lookup: given a token id (positionId), find its market.
 * Returns null if the token isn't on a Condition we know about.
 */
export async function fetchMarketForToken(args: {
  tokenId: string;
  signal?: AbortSignal;
}): Promise<{
  conditionId: string;
  outcomeIdx: number;
  resolutionTimestamp: number | null;
  payouts: string[] | null;
  winnerOutcomeIdx: number | null;
} | null> {
  const url = SUBGRAPHS.activity;
  // Activity subgraph has positionId -> Condition reverse lookup via the
  // Condition.positionIds field; we filter conditions where positionIds
  // contains the token.
  const query = `query Tok($tokenId: String!) {
    conditions(first: 1, where: { positionIds_contains: [$tokenId] }) {
      id
      resolutionTimestamp
      payouts
      positionIds
    }
  }`;
  const data = (await gqlPost(url, query, { tokenId: args.tokenId }, args.signal)) as {
    conditions?: Array<{
      id: string;
      resolutionTimestamp?: string | null;
      payouts?: string[] | null;
      positionIds?: string[] | null;
    }>;
  } | null;
  const c = data?.conditions?.[0];
  if (!c) return null;
  const positionIds = c.positionIds || [];
  const idx = positionIds.findIndex((t) => String(t) === args.tokenId);
  if (idx < 0) return null;
  const resTs = c.resolutionTimestamp != null ? Number(c.resolutionTimestamp) : null;
  const payouts = c.payouts ?? null;
  let winner: number | null = null;
  if (payouts && payouts.length >= 2) {
    for (let i = 0; i < payouts.length; i++) {
      const v = Number(payouts[i]);
      if (Number.isFinite(v) && v > 0.5) {
        winner = i;
        break;
      }
    }
  }
  return {
    conditionId: c.id,
    outcomeIdx: idx,
    resolutionTimestamp: resTs && Number.isFinite(resTs) && resTs > 0 ? resTs : null,
    payouts,
    winnerOutcomeIdx: winner,
  };
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
