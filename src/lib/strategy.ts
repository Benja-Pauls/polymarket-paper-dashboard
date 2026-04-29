// Multi-strategy paper-money configuration.
//
// All strategies share these defaults:
//   - $1000 starting bankroll, $10 stake/bet
//   - cap=N per market chronologically
//   - Bet only when:
//       category in `categories`  AND
//       entry_price ∈ [ep_lo, ep_hi)  AND
//       time_to_resolution ≥ min_hours_to_res  AND
//       (max_market_volume == null OR market_running_volume_usdc < max_market_volume)
//                                      AND
//       count of bets on this market < cap_per_market
//
// `baseline_v1` reproduces the original `tighter_blanket_cap10_3day` filter
// for backward comparison.

export type StrategyParams = {
  /** Allowed market categories (subset of TRADEABLE_CATEGORIES). */
  categories: string[];
  /** Lower bound (inclusive) on entry price. */
  ep_lo: number;
  /** Upper bound (exclusive) on entry price. */
  ep_hi: number;
  /** Minimum hours from trade ts -> market resolution ts. */
  min_hours_to_res: number;
  /**
   * Maximum cumulative on-chain notional volume (in USDC) seen on the market
   * BEFORE this trade. Set null to disable.
   */
  max_market_volume: number | null;
  /** Cap on bets per market (chronological). */
  cap_per_market: number;
  /** Slippage haircut on settlement. */
  slippage: number;
};

export type StrategyConfig = {
  id: string;
  name: string;
  description: string;
  startingBankroll: number;
  stake: number;
  active: boolean;
  params: StrategyParams;
};

/** Categories the cron will track. Strategies opt in via `params.categories`. */
export const TRADEABLE_CATEGORIES = new Set([
  "tradeable_geopolitical",
  "tradeable_political",
  "tradeable_corporate",
  "tradeable_crypto",
]);

const ALL_TRADEABLE_CATEGORIES = [
  "tradeable_geopolitical",
  "tradeable_political",
  "tradeable_corporate",
  "tradeable_crypto",
];

/**
 * Currently-tracked strategies. Add new ones here, then run `pnpm seed` to
 * upsert into the strategies table. Set `active: false` to retire a strategy
 * (it stops accumulating new signals/positions but historical rows are kept).
 */
export const STRATEGIES: StrategyConfig[] = [
  {
    id: "geo_deep_longshot_v1",
    name: "GEO Deep Longshot",
    description:
      "Geopolitical-only deep-longshot. Bet entry_price ∈ [0.05, 0.15) on tradeable_geopolitical markets, ≥24h to resolution, cap=20, market_cum_usdc_before < $100K. BAR 2 ALPHA-TIER: in-sample 21mo P5 = +$97K, forward-OOS 4mo mean ret/$ +1.25.",
    startingBankroll: 1000,
    stake: 10,
    active: true,
    params: {
      categories: ["tradeable_geopolitical"],
      ep_lo: 0.05,
      ep_hi: 0.15,
      min_hours_to_res: 24,
      max_market_volume: 100_000,
      cap_per_market: 20,
      slippage: 0.02,
    },
  },
  {
    id: "all_cat_tight_v1",
    name: "All-Cat Tight",
    description:
      "All tradeable_* with ep ∈ [0.10, 0.15), cap=5, ≥72h, vol<$100K. BAR 2 ALPHA: in-sample mean +0.99, forward +1.12.",
    startingBankroll: 1000,
    stake: 10,
    active: true,
    params: {
      categories: ALL_TRADEABLE_CATEGORIES,
      ep_lo: 0.1,
      ep_hi: 0.15,
      min_hours_to_res: 72,
      max_market_volume: 100_000,
      cap_per_market: 5,
      slippage: 0.02,
    },
  },
  {
    id: "all_cat_conservative_v1",
    name: "All-Cat Conservative",
    description:
      "All tradeable_* with ep ∈ [0.10, 0.20), cap=10, ≥72h, vol<$100K. Bar-1 floor: in-sample +0.76, forward +0.91.",
    startingBankroll: 1000,
    stake: 10,
    active: true,
    params: {
      categories: ALL_TRADEABLE_CATEGORIES,
      ep_lo: 0.1,
      ep_hi: 0.2,
      min_hours_to_res: 72,
      max_market_volume: 100_000,
      cap_per_market: 10,
      slippage: 0.02,
    },
  },
  {
    id: "baseline_v1",
    name: "Baseline (for comparison)",
    description:
      "Original tighter_blanket_cap10_3day: ep ∈ [0.10, 0.40), cap=10, ≥72h. No volume filter. Kept for comparison vs the improvements.",
    startingBankroll: 1000,
    stake: 10,
    active: true,
    params: {
      categories: ALL_TRADEABLE_CATEGORIES,
      ep_lo: 0.1,
      ep_hi: 0.4,
      min_hours_to_res: 72,
      max_market_volume: null,
      cap_per_market: 10,
      slippage: 0.02,
    },
  },
];

/**
 * Strategy id of the predecessor that should be retired (status -> 'retired')
 * when seed runs. We keep its rows for historical comparison but it stops
 * receiving new signals.
 */
export const RETIRED_STRATEGY_IDS: string[] = ["tighter_blanket_cap10_3day"];

export type TradeInput = {
  rawTradeId: string;
  conditionId: string;
  wallet: string | null;
  side: "BUY" | "SELL" | string;
  outcomeIdx: number;
  price: number;
  timestamp: number; // unix seconds
};

export type EvalDecision =
  | {
      action: "bet";
      reason: string;
      entryPrice: number;
      betOutcome: number;
      hoursToRes: number;
      category: string;
    }
  | {
      action: "skip";
      reason: string;
      entryPrice?: number;
      betOutcome?: number;
    };

/**
 * Apply one strategy's filter to a single trade.
 */
export function evaluateTrade(args: {
  trade: TradeInput;
  marketResolutionTs: number | null;
  marketCategory: string | null;
  /**
   * Cumulative on-chain USDC notional on this market BEFORE this trade.
   * Pass null when not tracking; the volume filter is then a no-op (passes).
   */
  marketRunningVolumeUsdc: number | null;
  marketBetCount: number;
  cash: number;
  stake: number;
  params: StrategyParams;
}): EvalDecision {
  const {
    trade,
    marketResolutionTs,
    marketCategory,
    marketRunningVolumeUsdc,
    marketBetCount,
    cash,
    stake,
    params,
  } = args;

  const side = String(trade.side || "").toUpperCase();
  if (side !== "BUY" && side !== "SELL") {
    return { action: "skip", reason: `non-binary side=${side}` };
  }
  const outcomeIdx = Number(trade.outcomeIdx);
  const price = Number(trade.price);
  if (!Number.isFinite(outcomeIdx) || !Number.isFinite(price)) {
    return { action: "skip", reason: "bad trade fields" };
  }
  if (outcomeIdx !== 0 && outcomeIdx !== 1) {
    return { action: "skip", reason: `non-binary outcome_idx=${outcomeIdx}` };
  }
  if (!(price >= 0.005 && price <= 0.995)) {
    return { action: "skip", reason: `price out of bounds: ${price}` };
  }

  const entryPrice = side === "BUY" ? price : 1 - price;
  const betOutcome = side === "BUY" ? outcomeIdx : 1 - outcomeIdx;

  if (marketCategory == null) {
    return { action: "skip", reason: "market not in tradeable_*", entryPrice, betOutcome };
  }
  if (!params.categories.includes(marketCategory)) {
    return {
      action: "skip",
      reason: `category=${marketCategory} not in strategy whitelist`,
      entryPrice,
      betOutcome,
    };
  }
  if (!(entryPrice >= params.ep_lo && entryPrice < params.ep_hi)) {
    return {
      action: "skip",
      reason: `entry_price=${entryPrice.toFixed(3)} outside [${params.ep_lo}, ${params.ep_hi})`,
      entryPrice,
      betOutcome,
    };
  }
  if (marketResolutionTs == null) {
    return {
      action: "skip",
      reason: "no resolution timestamp known",
      entryPrice,
      betOutcome,
    };
  }
  const hoursToRes = (marketResolutionTs - trade.timestamp) / 3600;
  if (hoursToRes < params.min_hours_to_res) {
    return {
      action: "skip",
      reason: `hours_to_res=${hoursToRes.toFixed(1)} < ${params.min_hours_to_res}`,
      entryPrice,
      betOutcome,
    };
  }
  if (
    params.max_market_volume != null &&
    marketRunningVolumeUsdc != null &&
    marketRunningVolumeUsdc >= params.max_market_volume
  ) {
    return {
      action: "skip",
      reason: `market vol $${marketRunningVolumeUsdc.toFixed(0)} ≥ cap $${params.max_market_volume}`,
      entryPrice,
      betOutcome,
    };
  }
  if (marketBetCount >= params.cap_per_market) {
    return {
      action: "skip",
      reason: `cap reached on this market (n=${marketBetCount})`,
      entryPrice,
      betOutcome,
    };
  }
  if (cash < stake) {
    return {
      action: "skip",
      reason: `insufficient cash ($${cash.toFixed(2)} < $${stake.toFixed(2)})`,
      entryPrice,
      betOutcome,
    };
  }

  return {
    action: "bet",
    reason: "passed all filters",
    entryPrice,
    betOutcome,
    hoursToRes,
    category: marketCategory,
  };
}

/**
 * Settle a position when its market has resolved.
 *
 *   payoff = stake / entry_price if won else 0
 *   payout = payoff * (1 - slippage) if won else 0
 *   realized_return = (1 - entry_price) / entry_price - slippage if won
 *                     else -1 - slippage
 */
export function settlePosition(args: {
  stake: number;
  entryPrice: number;
  betOutcome: number;
  winner: number;
  slippage: number;
}): { won: 0 | 1; payout: number; realizedReturn: number } {
  const { stake, entryPrice, betOutcome, winner, slippage } = args;
  const won: 0 | 1 = betOutcome === winner ? 1 : 0;
  if (won) {
    const grossPayoff = stake / entryPrice;
    const payout = grossPayoff * (1 - slippage);
    const realizedReturn = (1 - entryPrice) / entryPrice - slippage;
    return { won, payout, realizedReturn };
  }
  return { won, payout: 0, realizedReturn: -1 - slippage };
}

// Tripwire thresholds applied uniformly to every strategy.
export const TRIPWIRES = {
  maxCumulativeLossPct: 0.3,
  maxWeeklyLossPct: 0.2,
  top1ConcentrationPct: 50,
} as const;

export type TripwireStatus = {
  cumulativeLoss: { state: "green" | "yellow" | "red"; value: number; threshold: number };
  weeklyLoss: { state: "green" | "yellow" | "red"; value: number; threshold: number };
  top1Concentration: { state: "green" | "yellow" | "red"; value: number; threshold: number };
};

export function computeTripwireStatus(args: {
  startingBankroll: number;
  cumulativePnl: number;
  weeklyPnl: number;
  top1ConcentrationPct: number;
}): TripwireStatus {
  const { startingBankroll, cumulativePnl, weeklyPnl, top1ConcentrationPct } = args;

  const cumThreshold = startingBankroll * TRIPWIRES.maxCumulativeLossPct;
  const cumState: TripwireStatus["cumulativeLoss"]["state"] =
    -cumulativePnl >= cumThreshold
      ? "red"
      : -cumulativePnl >= cumThreshold * 0.66
        ? "yellow"
        : "green";

  const weekThreshold = startingBankroll * TRIPWIRES.maxWeeklyLossPct;
  const weekState: TripwireStatus["weeklyLoss"]["state"] =
    -weeklyPnl >= weekThreshold
      ? "red"
      : -weeklyPnl >= weekThreshold * 0.66
        ? "yellow"
        : "green";

  const concState: TripwireStatus["top1Concentration"]["state"] =
    top1ConcentrationPct >= TRIPWIRES.top1ConcentrationPct
      ? "red"
      : top1ConcentrationPct >= TRIPWIRES.top1ConcentrationPct * 0.66
        ? "yellow"
        : "green";

  return {
    cumulativeLoss: {
      state: cumState,
      value: -cumulativePnl,
      threshold: cumThreshold,
    },
    weeklyLoss: {
      state: weekState,
      value: -weeklyPnl,
      threshold: weekThreshold,
    },
    top1Concentration: {
      state: concState,
      value: top1ConcentrationPct,
      threshold: TRIPWIRES.top1ConcentrationPct,
    },
  };
}
