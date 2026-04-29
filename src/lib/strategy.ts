// Strategy parameters for tighter_blanket_cap10_3day.
//
// Frozen post-forward-OOS validation 2026-04-28 (Bar 1 floor candidate):
//   - mean ret/$ = +0.637 over 21-month test
//   - bootstrap P5 = +$16.7K on $5K bankroll
//   - top-1 conc 3.9%, 51 bets/mo, P_pos = 100%
//   - robust to +5% additional slippage (P5 stays $14.1K)
//   - leave-one-market-out P5 stays $13.6-15K
//
// Source: scripts/live_monitor.py from polymarket-insider-detection.
export const STRATEGY = {
  id: "tighter_blanket_cap10_3day",
  name: "tighter_blanket_cap10_3day",
  description:
    "Tighter blanket cap-10 strategy. Buy any tradeable_* market trade where entry_price ∈ [0.10, 0.40), ≥72h to resolution, capped at 10 bets per market chronologically. Validated as a Bar 1 (floor) candidate.",
  startingBankroll: 1000,
  stake: 10,
  params: {
    ep_lo: 0.1,
    ep_hi: 0.4,
    min_hours_to_res: 72,
    cap_per_market: 10,
    slippage: 0.02,
  },
} as const;

export const TRADEABLE_CATEGORIES = new Set([
  "tradeable_geopolitical",
  "tradeable_political",
  "tradeable_corporate",
  "tradeable_crypto",
]);

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
 * Apply the strategy filter to a single trade. Mirrors evaluate_trade() in
 * scripts/live_monitor.py.
 */
export function evaluateTrade(args: {
  trade: TradeInput;
  marketResolutionTs: number | null;
  marketCategory: string | null;
  marketBetCount: number;
  cash: number;
  stake: number;
  params: typeof STRATEGY.params;
}): EvalDecision {
  const { trade, marketResolutionTs, marketCategory, marketBetCount, cash, stake, params } =
    args;

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
  if (!TRADEABLE_CATEGORIES.has(marketCategory)) {
    return {
      action: "skip",
      reason: `category=${marketCategory} not tradeable_*`,
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
 * Mirrors settle_resolved_positions() in live_monitor.py:
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

// Tripwire thresholds (mirror DEFAULT_TRIPWIRES in live_monitor.py).
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
