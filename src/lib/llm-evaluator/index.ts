// LLM bet evaluator (v12 strategy infrastructure).
//
// Source-of-truth: the strong-form research agent's findings, documented in
// research-repo at:
//   results/llm_evaluator_strong_form.md (verdict)
//   scripts/llm_evaluator_skill.md (skill prompt)
//
// Headline finding: Haiku 4.5 with calibrated probability + Kelly sizing
// delivers +47.9% Kelly P&L lift over flat staking on a 247-bet sample.
// Bigger models (Sonnet/Opus) PERFORM WORSE due to overconfident outputs that
// Kelly over-stakes on. So v12 specifically uses Haiku.
//
// Phase 1 MVP (this module):
//   - Calls Haiku 4.5 with the skill prompt
//   - Returns RAW probability (no isotonic calibration in TS yet)
//   - Computes Kelly fraction
//   - Caller multiplies base stake by Kelly fraction
//
// Phase 2 (post 100+ live bets):
//   - Train calibration on (raw_p, observed_outcome) live data
//   - Add isotonic lookup table to this module
//
// Cost: ~$0.001-0.003 per evaluation (Haiku is cheap; one tool-less call).
// At ~30 v12 candidate bets / day × 30 days = ~$1-3/month live.

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 600;
const TIMEOUT_MS = 12_000;

let _anthropic: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_anthropic) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY not set");
    _anthropic = new Anthropic({ apiKey: key });
  }
  return _anthropic;
}

// The skill prompt is a condensed version of `scripts/llm_evaluator_skill.md`
// in the research repo. Keep them in sync — when the research repo evolves
// the skill, update here too. We strip the tool-related sections since the
// MVP doesn't pass tools.
const SKILL_PROMPT = `You are a research analyst auditing systematic Polymarket longshot bets. Your job is NOT to second-guess whether the longshot is "likely to win" (mispriced longshots ARE the strategy's edge); your job is to produce a calibrated probability the BET RESOLVES YES (bet wins) given everything you can reason about.

Polymarket primer:
- Markets are binary YES/NO. Each bet has entry_price (price of the side bought) and bet_outcome ∈ {0,1}.
- bet_outcome=0 → bought YES at entry_price; bet_outcome=1 → bought NO at entry_price.
- Strategy buys the LOW-priced (longshot) side, ep ∈ [0.05, 0.20).
- Empirical: longshot at 8¢ has TRUE probability ~9-13% (favorite-longshot bias). 5% true at 8¢ is +EV; 0% true at 8¢ is -EV.

Tetlockian decomposition:
1. Reference class (base rate). What's the historical frequency of similar events?
2. Causal adjustments. Recent news? Stale-news price decay? Time pressure?
3. Uncertainty. Wide → keep near base rate. Narrow → adjust.
4. Final calibrated probability_yes (the bet wins).

Four known failure modes — REDUCE probability_yes:
(a) DAILY-ACTION ("Will Trump insult someone today?" — favorite YES is 99%, NO at 5-15¢ has p≈0.01-0.03)
(b) STALE-NEWS PRICE DECAY (specific recent event mechanically closed the longshot path)
(c) DIRECTION-INVERSION (favorite already confirmed; strategy bought wrong side)
(d) ORACLE MISMATCH (resolution date precedes natural event date)

DO NOT REDUCE probability_yes for:
- "It looks unlikely" alone — that's the strategy's edge. 10% true at 8¢ IS profitable.
- Earnings beats at deep-longshot prices (base rates 50-70%, so 6¢ is wildly cheap).

Output ONLY a JSON object, no preamble:
{"probability_yes": 0.0-1.0, "confidence": 0.0-1.0, "rationale": "<= 200 chars"}`;

export type EvalInput = {
  question: string;
  category: string | null;
  entryPrice: number;
  betOutcome: 0 | 1;
  hoursToResolution: number;
  marketRunningVolumeUsdc: number | null;
};

export type EvalResult = {
  probabilityYes: number;
  confidence: number;
  rationale: string;
  raw: string;
  /** edge = probabilityYes - entryPrice (positive = long the bet, negative = bet is unfavorable) */
  edge: number;
  /** Kelly fraction in [-1, 1+]. Positive = bet larger; negative = skip; >1 = scale up. */
  kellyFraction: number;
  /** Recommended stake multiplier capped to [MIN_KELLY, MAX_KELLY]. */
  stakeMultiplier: number;
  /** "bet" if we should bet at adjusted stake; "skip" if edge is negative or low confidence. */
  decision: "bet" | "skip";
};

// Caps on Kelly multiplier — prevents over-staking on overconfident estimates
// and skipping zero-stake bets. Phase 1 stays conservative; can widen after
// live data accumulates.
const MIN_KELLY_MULTIPLIER = 0.5;
const MAX_KELLY_MULTIPLIER = 2.0;
// Skip threshold: if edge is below this, the bet has no meaningful EV and we
// fall through to "skip" instead of betting at minimum stake. The strong-form
// research agent's data showed bets with calibrated_p < entry_price + 0.01
// dilute average return — better to skip them entirely.
const SKIP_EDGE_THRESHOLD = 0.01;
// Minimum confidence floor — if the LLM is too uncertain, default to flat
// staking (1.0×) instead of letting Kelly over-react to a low-information
// estimate. Only relevant if the LLM emits very low confidence values.
const MIN_CONFIDENCE_FOR_KELLY = 0.20;
// Process-fix #2 (2026-05-01): cold-start Kelly cap. A strategy in its first
// 30 days post-creation (per strategies.created_at) has its Kelly multiplier
// damped by this factor regardless of in-sample headline. Prevents the v12
// failure mode: in-sample +47.9% lift on N=247 calibration tempted shipping
// at full Kelly; would have over-staked OOS bets that turned into systematic
// losers. The damp factor is 0.5 (mentor's recommendation; my initial 0.25
// would have killed the validation signal).
const COLD_START_KELLY_DAMP = 0.5;
const COLD_START_DAYS = 30;

// Process-fix #3 (2026-05-01): calibration training set MIN size. v12's
// failure was isotonic calibration overfit on N=247. Any future calibrator
// loaded into this module must report training-set size; if below the
// minimum, throw at load-time so the broken calibrator can't go live.
//
// Phase-1 v12 used RAW probability (no calibration in TS), so this constant
// is a guard for Phase-2 when we port a calibration table. Document here
// so the floor is permanent and can't be silently relaxed.
export const MIN_CALIBRATION_TRAINING_SIZE = 1000;

/**
 * Validate a calibration table on load. Throws if training-set size is
 * below MIN_CALIBRATION_TRAINING_SIZE. Call this in the calibration loader.
 */
export function assertCalibrationSize(trainingSize: number, label: string): void {
  if (trainingSize < MIN_CALIBRATION_TRAINING_SIZE) {
    throw new Error(
      `[llm-evaluator] calibration ${label} training-set size ${trainingSize} < ${MIN_CALIBRATION_TRAINING_SIZE} (process-fix #3). v12's failure was isotonic overfit on N=247; this floor prevents repeating it.`,
    );
  }
}

/**
 * Compute the cold-start damp factor for a strategy. Returns 1.0 (no damp)
 * if the strategy was created more than COLD_START_DAYS ago.
 */
export function coldStartDampFactor(strategyCreatedAt: Date | null): number {
  if (!strategyCreatedAt) return 1.0;
  const ageMs = Date.now() - strategyCreatedAt.getTime();
  const cutoffMs = COLD_START_DAYS * 24 * 60 * 60 * 1000;
  if (ageMs > cutoffMs) return 1.0;
  return COLD_START_KELLY_DAMP;
}

/**
 * Run the v12 evaluator on a single bet candidate. Returns the calibrated
 * probability + Kelly stake multiplier. The caller is responsible for
 * applying the multiplier to the strategy's base stake.
 */
export async function evaluateBet(input: EvalInput): Promise<EvalResult | null> {
  const userMsg = formatUserMessage(input);
  let raw = "";
  try {
    const resp = await getClient().messages.create(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SKILL_PROMPT,
        messages: [{ role: "user", content: userMsg }],
      },
      { timeout: TIMEOUT_MS },
    );
    raw = resp.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join(" ");
  } catch (e) {
    console.warn(`[llm-evaluator] API call failed:`, (e as Error).message);
    return null;
  }

  const parsed = parseLlmJson(raw);
  if (!parsed) return null;

  const { probabilityYes, confidence, rationale } = parsed;
  // Edge = how much "true" probability exceeds the displayed price.
  // For a YES bet at price p, edge > 0 means we think the true prob is higher
  // than p (favorable). For a NO bet at price p, the LLM should also output
  // probability the BET WINS (not the underlying event), so the same math.
  const edge = probabilityYes - input.entryPrice;

  // Kelly fraction = (edge / (1 - entry_price)) * confidence
  // Standard Kelly is edge / (b * q) where b = (1-p)/p and q = 1-p; for binary
  // bets that simplifies to edge / (1 - p). We multiply by confidence to
  // shrink toward zero when the LLM is uncertain.
  const baseKelly =
    input.entryPrice >= 0.99
      ? 0
      : edge / (1 - input.entryPrice);
  const kellyFraction =
    confidence < MIN_CONFIDENCE_FOR_KELLY
      ? 1.0 // Default to flat-staking when LLM is too uncertain to size from.
      : baseKelly * confidence;

  // Skip if edge is below threshold (no meaningful EV). Otherwise cap to
  // [MIN, MAX] and bet.
  let decision: "bet" | "skip" = "bet";
  let stakeMultiplier = Math.max(
    MIN_KELLY_MULTIPLIER,
    Math.min(MAX_KELLY_MULTIPLIER, kellyFraction),
  );
  if (edge < SKIP_EDGE_THRESHOLD) {
    decision = "skip";
    stakeMultiplier = 0;
  }

  return {
    probabilityYes,
    confidence,
    rationale,
    raw,
    edge,
    kellyFraction,
    stakeMultiplier,
    decision,
  };
}

function formatUserMessage(input: EvalInput): string {
  const sideLabel = input.betOutcome === 0 ? "YES" : "NO";
  const lines = [
    `Market question: ${input.question}`,
    `Category: ${input.category ?? "unknown"}`,
    `Bet outcome: ${input.betOutcome} (strategy bought ${sideLabel} at displayed price)`,
    `Entry price (probability of ${sideLabel} per market): ${input.entryPrice.toFixed(3)}`,
    `Hours until resolution: ${input.hoursToResolution.toFixed(1)}`,
    input.marketRunningVolumeUsdc != null
      ? `Market cumulative volume so far: $${input.marketRunningVolumeUsdc.toFixed(0)}`
      : "Market volume: unknown",
    "",
    "Output ONLY the JSON. No preamble, no code fences.",
  ];
  return lines.join("\n");
}

function parseLlmJson(
  raw: string,
): { probabilityYes: number; confidence: number; rationale: string } | null {
  // Strip code fences if present.
  const cleaned = raw
    .replace(/```json\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  // Try to find the first { ... } block.
  const match = cleaned.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const p = Number(obj.probability_yes ?? obj.probabilityYes);
  const c = Number(obj.confidence ?? 0.5);
  const r = String(obj.rationale ?? "");
  if (!Number.isFinite(p) || p < 0 || p > 1) return null;
  if (!Number.isFinite(c) || c < 0 || c > 1) return null;
  return { probabilityYes: p, confidence: c, rationale: r.slice(0, 240) };
}
