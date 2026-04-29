// Unit test for the question-pattern exclusion filter (wave 8 / v4_broad_clean_v1).
//
// Run:    pnpm exec tsx scripts/test_question_pattern_filter.ts
// Exits non-zero on any failed assertion. No DB / network access.
//
// Coverage:
//   1. findExcludedPattern() returns the matched pattern name on known-bad
//      question text (regime change, election, etc.).
//   2. findExcludedPattern() returns null for benign question text and for
//      empty/null inputs.
//   3. evaluateTrade() with v4_broad_clean_v1's params SKIPS a trade on a
//      market whose question text matches a regime-change pattern, with
//      reason starting "question matches excluded pattern: regime_change".
//   4. evaluateTrade() with the same params and otherwise-identical input
//      ALLOWS a trade on a market whose question text is benign (e.g.
//      "Will the Yankees beat the Red Sox by 5+ runs?").

import {
  evaluateTrade,
  findExcludedPattern,
  QUESTION_EXCLUSION_PATTERNS,
  STRATEGIES,
  type StrategyParams,
} from "../src/lib/strategy";

let failures = 0;
function assert(cond: unknown, label: string): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}`);
    failures += 1;
  }
}
function assertEq<T>(actual: T, expected: T, label: string): void {
  const ok =
    actual === expected ||
    (typeof actual === "object" &&
      JSON.stringify(actual) === JSON.stringify(expected));
  if (ok) {
    console.log(`  PASS  ${label}  (=${JSON.stringify(actual)})`);
  } else {
    console.log(
      `  FAIL  ${label}  (expected=${JSON.stringify(expected)} got=${JSON.stringify(actual)})`,
    );
    failures += 1;
  }
}

console.log("=".repeat(70));
console.log("QUESTION-PATTERN EXCLUSION FILTER — UNIT TEST");
console.log("=".repeat(70));

const ALL_PATTERNS = Object.keys(QUESTION_EXCLUSION_PATTERNS);
console.log(`registered patterns: ${ALL_PATTERNS.join(", ")}`);
console.log();

// ─── 1. findExcludedPattern() — positive cases ─────────────────────────
console.log("[1] findExcludedPattern — positive matches");
const positiveCases: Array<{ q: string; expected: string }> = [
  // Regime change family
  { q: "Will Putin's regime fall by end of 2026?", expected: "regime_change" },
  { q: "Will there be a coup in country X this year?", expected: "regime_change" },
  { q: "Will the President resign before Aug 2026?", expected: "regime_change" },
  { q: "Will the Senate impeach the official?", expected: "regime_change" },
  // Election
  { q: "Who will be elected next president?", expected: "election" },
  { q: "Will candidate Y win the 2026 primary?", expected: "election" },
  // Tech test
  { q: "Will SpaceX launch Starship before March?", expected: "tech_test" },
  { q: "Will North Korea test fire a missile?", expected: "tech_test" },
  // Legislative
  { q: "Will Congress approve the bill before April?", expected: "legislative" },
  { q: "Will the President veto the act?", expected: "legislative" },
  // Judicial
  { q: "Will the defendant be convict-ed in this trial?", expected: "judicial" },
  { q: "Will an arrest be made before May?", expected: "judicial" },
  // Announcement
  { q: "Will Trump tweet about Iran by Tuesday?", expected: "announcement" },
  { q: "Will the company announce its earnings?", expected: "announcement" },
  // Diplomatic
  { q: "Will the US and China sign a deal in 2026?", expected: "diplomatic" },
  { q: "Will there be a ceasefire by end of month?", expected: "diplomatic" },
  // Price threshold
  { q: "Will Bitcoin price hit $100k by July?", expected: "price_threshold" },
  { q: "Will ETH cross $5,000 in 2026?", expected: "price_threshold" },
];

for (const { q, expected } of positiveCases) {
  const got = findExcludedPattern({
    questionText: q,
    excludePatterns: ALL_PATTERNS,
  });
  assertEq(got, expected, `match: "${q}" → ${expected}`);
}

// ─── 2. findExcludedPattern() — negative / edge cases ──────────────────
console.log();
console.log("[2] findExcludedPattern — null / benign inputs");
assertEq(
  findExcludedPattern({ questionText: null, excludePatterns: ALL_PATTERNS }),
  null,
  "null question text → null",
);
assertEq(
  findExcludedPattern({ questionText: undefined, excludePatterns: ALL_PATTERNS }),
  null,
  "undefined question text → null",
);
assertEq(
  findExcludedPattern({ questionText: "", excludePatterns: ALL_PATTERNS }),
  null,
  "empty question text → null",
);
assertEq(
  findExcludedPattern({ questionText: "anything", excludePatterns: [] }),
  null,
  "empty pattern list → null",
);
assertEq(
  findExcludedPattern({
    questionText: "Will Mahomes throw 4+ TDs?",
    excludePatterns: ALL_PATTERNS,
  }),
  null,
  "benign sports question → null (no inertia patterns match)",
);
assertEq(
  findExcludedPattern({
    questionText: "Will it rain in Seattle on Friday?",
    excludePatterns: ALL_PATTERNS,
  }),
  null,
  "benign weather question → null",
);
// Honor caller's allowlist: an excluded-by-default question should pass when
// the caller doesn't include the pattern.
assertEq(
  findExcludedPattern({
    questionText: "Will Putin's regime fall by 2026?",
    excludePatterns: ["election", "tech_test"],
  }),
  null,
  "regime question + only [election, tech_test] excluded → null",
);

// ─── 3. evaluateTrade() — broad-clean params, regime-change market ─────
console.log();
console.log("[3] evaluateTrade — regime-change market is SKIPPED");
const broadClean = STRATEGIES.find((s) => s.id === "v4_broad_clean_v1");
if (!broadClean) {
  console.log("  FAIL  v4_broad_clean_v1 not registered in STRATEGIES");
  failures += 1;
  process.exit(1);
}
const params: StrategyParams = broadClean.params;
const TRADE_TS = 1_750_000_000; // arbitrary
const RES_TS = TRADE_TS + 7 * 86_400; // 7 days out — passes 72h floor and 30d cap
const baseTrade = {
  rawTradeId: "test-1",
  conditionId: "0xtest",
  wallet: "0xwallet",
  side: "BUY",
  outcomeIdx: 1,
  price: 0.1, // entry_price = 0.1 for BUY → in [0.05, 0.15)
  timestamp: TRADE_TS,
};

const skipDecision = evaluateTrade({
  trade: baseTrade,
  marketResolutionTs: RES_TS,
  marketCategory: "tradeable_geopolitical",
  marketRunningVolumeUsdc: 50_000, // no cap on this strategy, but pass anyway
  marketBetCount: 0,
  marketCatalystTs: null,
  marketCatalystSource: null,
  marketQuestionText: "Will Putin's regime fall by end of 2026?",
  cash: 1000,
  stake: 10,
  params,
});
assertEq(skipDecision.action, "skip", "regime-change question → action=skip");
assert(
  skipDecision.action === "skip" &&
    skipDecision.reason.startsWith("question matches excluded pattern: regime_change"),
  `skip reason starts with "question matches excluded pattern: regime_change"  (got: ${skipDecision.reason})`,
);

// ─── 4. evaluateTrade() — broad-clean params, benign market ────────────
console.log();
console.log("[4] evaluateTrade — benign market is BET");
const betDecision = evaluateTrade({
  trade: baseTrade,
  marketResolutionTs: RES_TS,
  marketCategory: "tradeable_geopolitical",
  marketRunningVolumeUsdc: 50_000,
  marketBetCount: 0,
  marketCatalystTs: null,
  marketCatalystSource: null,
  marketQuestionText: "Will the city hold a new municipal referendum by Q4?",
  cash: 1000,
  stake: 10,
  params,
});
// Note: the above does NOT match any of the 8 patterns (no regime/election/
// announce/etc keywords). Should bet.
assertEq(betDecision.action, "bet", "benign question → action=bet");

// And a known-bad question with the SAME params but null question_text
// should ALSO bet — we don't filter on missing data.
console.log();
console.log("[5] evaluateTrade — null question_text still BETS (no signal)");
const nullQuestionDecision = evaluateTrade({
  trade: baseTrade,
  marketResolutionTs: RES_TS,
  marketCategory: "tradeable_geopolitical",
  marketRunningVolumeUsdc: 50_000,
  marketBetCount: 0,
  marketCatalystTs: null,
  marketCatalystSource: null,
  marketQuestionText: null,
  cash: 1000,
  stake: 10,
  params,
});
assertEq(
  nullQuestionDecision.action,
  "bet",
  "null question_text + otherwise-bettable trade → action=bet",
);

console.log();
console.log("=".repeat(70));
if (failures === 0) {
  console.log(`OK — all assertions passed.`);
  process.exit(0);
} else {
  console.log(`FAIL — ${failures} assertion(s) failed.`);
  process.exit(1);
}
