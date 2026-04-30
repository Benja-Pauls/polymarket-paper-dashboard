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
//       count of bets on this market < cap_per_market  AND
//       (skip_dow_utc not set OR dow(trade_ts UTC) NOT IN skip_dow_utc) AND
//       (require_future_catalyst != true OR market has catalyst_ts > trade_ts)
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
   * Maximum hours from trade ts -> market resolution ts (set to null to
   * disable, treat unspecified as 720h = 30 days for safety).
   *
   * Backtest finding (favorite-longshot strategies):
   *   <24h: mean_ret/$ -0.29 (LOSES — favorite locked in, no surprise time)
   *   3-7d: +1.50 (BIG WIN, surprise potential intact)
   *   30d:  break-even
   *   >30d: drag, ties up paper-trade capital
   *
   * Default 720h (30 days) keeps the favorite-longshot edge intact AND ensures
   * paper-trade positions resolve within ~1 month so we can validate strategies
   * on realistic horizons (vs the original bug where strategies bet on 8-month
   * resolution markets, blocking validation).
   */
  max_hours_to_res?: number | null;
  /**
   * Maximum cumulative on-chain notional volume (in USDC) seen on the market
   * BEFORE this trade. Set null to disable.
   */
  max_market_volume: number | null;
  /** Cap on bets per market (chronological). */
  cap_per_market: number;
  /** Slippage haircut on settlement. */
  slippage: number;
  /**
   * Day-of-week filter in JS UTC convention (Sunday=0, Monday=1, ..., Saturday=6).
   * If set, trades that fall on any of these days (in UTC) are SKIPPED.
   * Example: [3] skips Wednesday UTC.
   * Note: Python pandas `dt.dayofweek` uses Monday=0..Sunday=6, so to translate:
   *   js_dow = (python_dow + 1) % 7  (e.g. Python Wednesday=2 -> JS Wednesday=3)
   */
  skip_dow_utc?: number[];
  /**
   * If true, only bet when the market has a known public catalyst (in
   * `market_catalysts`) AND that catalyst's timestamp is in the FUTURE relative
   * to the trade timestamp. Markets with no catalyst record are skipped.
   */
  require_future_catalyst?: boolean;
  /**
   * Minimum required lead time (in hours) between the trade and the catalyst.
   * Only meaningful in combination with `require_future_catalyst: true` and
   * a non-null `marketCatalystTs`. When set, requires
   * `catalyst_ts - trade_ts >= min_catalyst_lead_hours * 3600`.
   * Use case: catalysts within 0–3 days have effectively arrived (favorite
   * locked in); requiring ≥ 3 days of lead time keeps surprise potential.
   */
  min_catalyst_lead_hours?: number;
  /**
   * If true, only accept catalysts whose `catalyst_source` is a real news
   * source ('gdelt' or 'wikipedia'). Heuristic-only catalysts (i.e. any
   * source value of 'heuristic' or null) are rejected. Only meaningful in
   * combination with `require_future_catalyst: true`.
   */
  require_real_catalyst_source?: boolean;
  /**
   * MIRROR-FAVORITE (Wave 9).  When set, BUY trades at price ≥ this threshold
   * are interpreted as a synthetic "BUY the OTHER outcome at (1 - price)"
   * signal — i.e., the favorite was bought, so we mirror to a longshot bet.
   *
   * Backtest finding (results/wave9_mirror_favorite.md, 21mo test):
   *   Standalone mirror (orig ep in (0.60, 0.95)): mean ret/$ +0.507, 1252
   *     bets, P5 +$9,542 on $5K bankroll, P_pos 0.994 — Bar-1 PASS.
   *   Combined direct + mirror: P5 +$27,377, 2134 bets, mean ret/$ +0.555.
   *   Geo-only mirror is the strongest: +0.733 ret/$ on 542 bets.
   *
   * When this is set together with ep_lo / ep_hi, the SYNTHESIZED entry price
   * (= 1 - orig_price) must satisfy [ep_lo, ep_hi). E.g. mirror_min=0.60
   * + ep [0.10, 0.40) means we accept BUYs at orig price in (0.60, 0.90].
   *
   * Only applies to side=BUY trades. SELLs go through the existing
   * SELL-side mirror logic (entryPrice = 1 - price, betOutcome = 1 - idx).
   */
  mirror_favorite_min_orig_price?: number | null;
  /**
   * Optional list of question-pattern category names to EXCLUDE. Each name
   * maps to a regex defined in `QUESTION_EXCLUSION_PATTERNS` below. If the
   * market's `question_text` matches any of the listed patterns, the trade
   * is skipped.
   *
   * Wave 8 finding: favorite-longshot bias only works in markets where
   * outcomes can SURPRISE. Markets anchored by structural inertia (regime
   * change, elections, judicial rulings, scheduled announcements, etc.)
   * resolve to the status-quo favorite — they don't surprise. Excluding
   * these patterns lifts both per-bet edge AND market diversification.
   *
   * Available pattern names (see QUESTION_EXCLUSION_PATTERNS for regexes):
   *   - regime_change
   *   - tech_test
   *   - legislative
   *   - judicial
   *   - announcement
   *   - diplomatic
   *   - election
   *   - price_threshold
   */
  exclude_question_patterns?: string[];
};

/**
 * Regex patterns for question-text exclusion. Sourced from the wave 8
 * `wave8_question_patterns_v4.py` Python classifier; ported to JS regex
 * (with `\b` word boundaries) and made case-insensitive via the `i` flag.
 *
 * IMPORTANT: keep these in sync with the Python `classify_pattern` function
 * — a market is "in" a pattern if its lowercased question matches the regex.
 * The Python classifier uses an if/elif chain so a question only ever lands
 * in one bucket, but the dashboard's exclusion filter treats them as a
 * union: ANY match excludes the trade.
 */
export const QUESTION_EXCLUSION_PATTERNS: Record<string, RegExp> = {
  regime_change:
    /\b(coup|regime|overthr|topple|resign|impeach|step down)/i,
  tech_test:
    /\b(launch|tested|test fire|test launch|develop|rocket|satellite)/i,
  legislative:
    /\b(approve|reject|pass|veto|signed|ratif|confirm)/i,
  judicial:
    /\b(arrest|indict|guilty|verdict|trial|convict)/i,
  announcement:
    /\b(announc|tweet|comment|claim|state|report|public statement)/i,
  diplomatic:
    /\b(meet|visit|talks|treaty|deal|ceasefire|negotiat|summit|peace|accord)/i,
  election:
    /\b(elected|election|presiden|prime minister|wins\s+race|lose\s+race|primary)/i,
  price_threshold:
    /\b(price|hit|reach|exceed|cross|bitcoin|ethereum|btc|eth|stock|all.time|index)/i,
};

/**
 * Returns the FIRST excluded pattern name whose regex matches the question
 * text, or null if no exclusion pattern matches. Unknown pattern names in
 * `excludePatterns` are silently skipped (no-op).
 */
export function findExcludedPattern(args: {
  questionText: string | null | undefined;
  excludePatterns: string[];
}): string | null {
  const { questionText, excludePatterns } = args;
  if (!questionText || excludePatterns.length === 0) return null;
  // The Python classifier lowercases before testing, so do the same here for
  // robust matching even though the regexes already have the `i` flag.
  const q = questionText.toLowerCase();
  for (const name of excludePatterns) {
    const re = QUESTION_EXCLUSION_PATTERNS[name];
    if (!re) continue;
    if (re.test(q)) return name;
  }
  return null;
}

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
  {
    id: "geo_deep_longshot_v2_skipwed",
    name: "GEO Deep Longshot v2 (Skip Wed)",
    description:
      "GEO Deep Longshot v1 + skip Wednesday UTC filter. Wednesday loses money in BOTH samples (-0.10 in-sample, -0.91 forward). In-sample mean_ret/$ +1.45 (vs v1 +1.27), forward +1.37 (vs v1 +1.25). Skip-Wed validated as 5th filter.",
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
      // Wednesday in JS UTC convention (Sunday=0). Equivalent to Python dt.dayofweek==2.
      skip_dow_utc: [3],
      slippage: 0.02,
    },
  },
  {
    id: "geo_deep_longshot_v3_catalyst",
    name: "GEO Deep Longshot v3 (Catalyst Future)",
    description:
      "GEO Deep Longshot v1 + only bet when a public catalyst is in the future. Catalyst-future filter VALIDATED forward-OOS: in-sample +3.93 mean_ret/$, forward +1.78. Smaller universe (more concentrated) but higher per-bet edge.",
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
      require_future_catalyst: true,
      slippage: 0.02,
    },
  },
  {
    id: "geo_deep_longshot_v4_catalyst_3d",
    name: "GEO Deep Longshot v4 (Catalyst ≥3d)",
    description:
      "GEO Deep Longshot + only bet when a public catalyst is ≥ 3 days in the future. Mechanism: catalyst within 0-3 days = news has effectively arrived (favorite locked in). Catalyst ≥ 3 days = surprise potential intact. STRONGEST forward result yet: +3.19 mean_ret/$, +$44K total / 3.6mo. Per-year alpha-tier in 2024 (+6.13), 2025 (+4.22), 2026 (+4.00).",
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
      require_future_catalyst: true,
      // Catalyst must be ≥ 3 days in the future at trade time.
      min_catalyst_lead_hours: 72,
      // Exclude heuristic-only catalysts; require gdelt or wikipedia source.
      require_real_catalyst_source: true,
      slippage: 0.02,
    },
  },
  {
    id: "v4_broad_clean_v1",
    name: "Broad Clean (v4-broad-clean)",
    description:
      "All-tradeable-categories favorite-longshot with 8 semantic exclusions. Deep-longshot doesn't work in markets anchored by structural inertia (regime change, election, legislative, judicial, etc.). Exclude those 8 question patterns. Highest bootstrap P5 of any variant ($19.8K forward) and best diversification (89 markets vs GEO v4's 16). Bar-1 floor strategy, complementary to GEO Deep Longshot.",
    startingBankroll: 1000,
    stake: 10,
    active: true,
    params: {
      categories: [
        "tradeable_geopolitical",
        "tradeable_political",
        "tradeable_corporate",
        "tradeable_crypto",
      ],
      ep_lo: 0.05,
      ep_hi: 0.15,
      min_hours_to_res: 72,
      max_hours_to_res: 720, // 30d default
      max_market_volume: null, // no volume cap for this variant
      cap_per_market: 10,
      slippage: 0.02,
      exclude_question_patterns: [
        "regime_change",
        "tech_test",
        "legislative",
        "judicial",
        "announcement",
        "diplomatic",
        "election",
        "price_threshold",
      ],
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
  /**
   * Public-catalyst timestamp (unix seconds) for this market, if known. Used by
   * strategies with `require_future_catalyst: true`. Pass null/undefined when
   * no catalyst is recorded; the filter then SKIPS this trade for catalyst-
   * gated strategies.
   */
  marketCatalystTs?: number | null;
  /**
   * Public-catalyst source label for this market, if known. One of
   * 'gdelt' | 'wikipedia' | 'heuristic' | null. Used by strategies with
   * `require_real_catalyst_source: true`.
   */
  marketCatalystSource?: string | null;
  /**
   * Market question text, if known. Used by strategies with
   * `exclude_question_patterns`. When the strategy specifies that filter
   * AND the question text is null/missing, the trade is allowed through
   * (no signal to filter on). When non-null, it's tested against each
   * named regex in `QUESTION_EXCLUSION_PATTERNS`.
   */
  marketQuestionText?: string | null;
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
    marketCatalystTs,
    marketCatalystSource,
    marketQuestionText,
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

  // Default longshot-side computation: BUY at p → bet outcomeIdx at p,
  // SELL at p → bet (1-outcomeIdx) at (1-p). The mirror-favorite block
  // below overrides this for high-price BUYs when the strategy opts in.
  let entryPrice = side === "BUY" ? price : 1 - price;
  let betOutcome = side === "BUY" ? outcomeIdx : 1 - outcomeIdx;

  // MIRROR-FAVORITE (Wave 9): when a BUY is on the favorite side at price ≥
  // mirror_min, treat it as a synthetic SELL signal (bet on the OTHER outcome
  // at 1-price). This captures the bias from the opposite angle and 5-10x's
  // bet rate. Doesn't fire for SELLs (those already get the equivalent
  // transformation above) or for BUYs below the threshold (which are already
  // longshot trades and go through the direct path).
  const mirrorMin = params.mirror_favorite_min_orig_price ?? null;
  if (mirrorMin != null && side === "BUY" && price >= mirrorMin) {
    entryPrice = 1 - price;
    betOutcome = 1 - outcomeIdx;
  }

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
  // Default max-hold to 30 days when not specified.  Backtest finding:
  // markets resolving > 30d out are break-even drag for favorite-longshot,
  // and they tie up paper-trade capital so we can't validate quickly.
  const maxHoursToRes =
    params.max_hours_to_res === null
      ? Number.POSITIVE_INFINITY
      : params.max_hours_to_res ?? 720; // 30 days default
  if (hoursToRes > maxHoursToRes) {
    return {
      action: "skip",
      reason: `hours_to_res=${hoursToRes.toFixed(1)} > ${maxHoursToRes}h cap (=${(maxHoursToRes / 24).toFixed(1)}d)`,
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
  if (params.skip_dow_utc && params.skip_dow_utc.length > 0) {
    // JS Date.getUTCDay(): Sunday=0, Monday=1, ..., Saturday=6.
    const dow = new Date(trade.timestamp * 1000).getUTCDay();
    if (params.skip_dow_utc.includes(dow)) {
      return {
        action: "skip",
        reason: `skip_dow_utc filter (dow=${dow})`,
        entryPrice,
        betOutcome,
      };
    }
  }
  if (params.require_future_catalyst === true) {
    if (marketCatalystTs == null) {
      return {
        action: "skip",
        reason: "no future catalyst (no catalyst record)",
        entryPrice,
        betOutcome,
      };
    }
    if (marketCatalystTs <= trade.timestamp) {
      return {
        action: "skip",
        reason: `no future catalyst (catalyst_ts=${marketCatalystTs} <= trade_ts=${trade.timestamp})`,
        entryPrice,
        betOutcome,
      };
    }
    // Optional minimum lead-time filter (e.g. require catalyst ≥ 3 days
    // in the future). Catalysts within 0–3 days have effectively arrived.
    if (
      typeof params.min_catalyst_lead_hours === "number" &&
      params.min_catalyst_lead_hours > 0
    ) {
      const leadSeconds = marketCatalystTs - trade.timestamp;
      const requiredSeconds = params.min_catalyst_lead_hours * 3600;
      if (leadSeconds < requiredSeconds) {
        const needDays = params.min_catalyst_lead_hours / 24;
        const haveDays = leadSeconds / 86400;
        return {
          action: "skip",
          reason: `catalyst within ${haveDays.toFixed(2)}d (need ≥${needDays}d)`,
          entryPrice,
          betOutcome,
        };
      }
    }
    // Optional "real-source" filter: only accept gdelt / wikipedia catalysts.
    // Reject heuristic-only catalysts (and unknown sources) as unreliable.
    if (params.require_real_catalyst_source === true) {
      const src = (marketCatalystSource ?? "").toLowerCase();
      if (src !== "gdelt" && src !== "wikipedia") {
        return {
          action: "skip",
          reason: `catalyst source=${marketCatalystSource ?? "null"} not in {gdelt, wikipedia}`,
          entryPrice,
          betOutcome,
        };
      }
    }
  }
  // Optional question-pattern exclusion filter (wave 8 finding).
  // Skip the trade if the market's question_text matches any of the named
  // patterns. If question_text is missing, the trade is allowed through —
  // we don't have a signal to filter on, and we don't want to silently
  // reject the entire universe just because a question lookup is stale.
  if (
    params.exclude_question_patterns &&
    params.exclude_question_patterns.length > 0 &&
    marketQuestionText
  ) {
    const matched = findExcludedPattern({
      questionText: marketQuestionText,
      excludePatterns: params.exclude_question_patterns,
    });
    if (matched != null) {
      return {
        action: "skip",
        reason: `question matches excluded pattern: ${matched}`,
        entryPrice,
        betOutcome,
      };
    }
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
