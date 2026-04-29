// Market category classification.
//
// Two layers:
//   1. Static label lookup (free) — `scripts/label_index.json` ships 15,567
//      condition_id -> category labels from the research repo.
//   2. Claude Haiku 4.5 classifier (~$0.0001/market on question text alone)
//      for any market not in the static index.
//
// Categories returned match `TRADEABLE_CATEGORIES` plus the negative classes
// used to deliberately mark a market as ineligible.

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// All categories we recognize. Tradeable_* are eligible; not_* are not.
const TRADEABLE = [
  "tradeable_geopolitical",
  "tradeable_political",
  "tradeable_corporate",
  "tradeable_crypto",
  "tradeable_awards",
  "tradeable_entertainment_scripted",
  "tradeable_medical",
  "tradeable_other",
] as const;

const NOT_TRADEABLE = [
  "not_tradeable_sports",
  "not_tradeable_price",
  "not_tradeable_social",
  "not_tradeable_election",
  "not_tradeable_weather",
] as const;

const ALL_CATEGORIES = [...TRADEABLE, ...NOT_TRADEABLE, "ambiguous", "unknown"] as const;
export type Category = (typeof ALL_CATEGORIES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Static label index (load lazily on first request)
// ─────────────────────────────────────────────────────────────────────────────

type LabelIndex = {
  generated_at: string;
  n: number;
  labels: Record<string, string>;
};

let _labelIndex: Map<string, string> | null = null;

function loadLabelIndex(): Map<string, string> {
  if (_labelIndex) return _labelIndex;
  try {
    const path = join(process.cwd(), "scripts", "label_index.json");
    const raw = readFileSync(path, "utf8");
    const data = JSON.parse(raw) as LabelIndex;
    _labelIndex = new Map(Object.entries(data.labels));
    console.log(`[classify] loaded ${_labelIndex.size.toLocaleString()} static labels`);
  } catch (e) {
    console.warn("[classify] failed to load label_index.json:", (e as Error).message);
    _labelIndex = new Map();
  }
  return _labelIndex;
}

/** Free O(1) lookup against the precomputed label index. */
export function lookupStaticLabel(conditionId: string): string | null {
  const idx = loadLabelIndex();
  return idx.get(conditionId.toLowerCase()) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude Haiku 4.5 classifier
// ─────────────────────────────────────────────────────────────────────────────

const CLASSIFY_SYSTEM = `You are a Polymarket market classifier. Categorize each market into ONE category from this list:

TRADEABLE (markets where retail bets on overlooked tail-risk are sometimes profitable):
- tradeable_geopolitical: wars, ceasefires, sanctions, foreign-relations events, military actions, treaties, summits
- tradeable_political: domestic politics, legislation passing, executive actions (NOT general elections)
- tradeable_corporate: M&A, IPOs, earnings, CEO changes, product launches, lawsuits
- tradeable_crypto: crypto-specific events (NOT just price levels): hacks, regulations, ETF approvals, listings
- tradeable_awards: Nobel/Oscar/Grammy winners, sports MVPs, lifetime achievement
- tradeable_entertainment_scripted: movie/show release dates, plot resolutions, sequel announcements
- tradeable_medical: drug approvals, disease milestones, CDC/FDA actions
- tradeable_other: any other tradeable_* not in the above buckets

NOT TRADEABLE (do not bet — too efficient or too random):
- not_tradeable_sports: sports game/match outcomes (NOT awards)
- not_tradeable_price: price-level questions ("BTC > 100K by EOY")
- not_tradeable_social: social-media events, celebrity tweets, viral content
- not_tradeable_election: general elections, primaries, polls, vote counts
- not_tradeable_weather: temperature, rainfall, hurricanes

OTHER:
- ambiguous: question text doesn't fit cleanly
- unknown: question text missing or unintelligible

Respond with ONE word — the exact category name.`;

const CLASSIFY_MODEL = "claude-haiku-4-5";

let _anthropic: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_anthropic) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY not set");
    _anthropic = new Anthropic({ apiKey: key });
  }
  return _anthropic;
}

/** Classify a single market. Returns null on error / empty question. */
export async function classifyOne(args: {
  question: string | null | undefined;
  signal?: AbortSignal;
}): Promise<string | null> {
  const q = (args.question ?? "").trim();
  if (!q) return null;
  try {
    const resp = await getClient().messages.create(
      {
        model: CLASSIFY_MODEL,
        max_tokens: 12,
        system: CLASSIFY_SYSTEM,
        messages: [{ role: "user", content: q.slice(0, 500) }],
      },
      { signal: args.signal },
    );
    const text =
      resp.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join(" ")
        .trim()
        .toLowerCase();
    return normalizeCategory(text);
  } catch (e) {
    console.warn(`[classify] one failed (${q.slice(0, 60)}...):`, (e as Error).message);
    return null;
  }
}

/**
 * Classify many markets in parallel with a small concurrency cap. Each call is
 * a single Haiku request — cheap (~$0.0001/market) and very fast (~300ms).
 *
 * Returns Map<conditionId, category | null>.
 */
export async function classifyMany(args: {
  items: Array<{ conditionId: string; question: string | null }>;
  concurrency?: number;
  signal?: AbortSignal;
  budgetUsd?: number; // conservative cost cap; default $5 per cron run
}): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const items = args.items.filter((it) => (it.question ?? "").trim());
  if (items.length === 0) return out;

  const concurrency = Math.max(1, Math.min(args.concurrency ?? 8, 16));
  // Rough estimated cost per Haiku call: ~$0.0001 (200 input + 12 output tokens).
  const COST_PER_CALL = 0.0002;
  const budget = args.budgetUsd ?? 5;
  const maxCalls = Math.floor(budget / COST_PER_CALL);
  if (items.length > maxCalls) {
    console.warn(
      `[classify] budget cap: ${items.length} items but limiting to ${maxCalls} (~$${budget})`,
    );
    items.length = maxCalls;
  }

  let i = 0;
  let totalCost = 0;
  async function worker() {
    while (i < items.length) {
      const cur = items[i++];
      const cat = await classifyOne({ question: cur.question, signal: args.signal });
      out.set(cur.conditionId, cat);
      totalCost += COST_PER_CALL;
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  console.log(
    `[classify] classified ${out.size}/${items.length} markets, est cost $${totalCost.toFixed(4)}`,
  );
  return out;
}

/** Map free-form Haiku output to a canonical category. */
function normalizeCategory(raw: string): string | null {
  if (!raw) return null;
  // Take first token, strip punctuation.
  const tok = raw.split(/[\s,.;:]/)[0].replace(/[^a-z_]/g, "");
  // Direct match
  for (const c of ALL_CATEGORIES) {
    if (tok === c) return c;
  }
  // Loose contains-match (e.g. "tradeable_geopolitical." or "category=tradeable_political")
  for (const c of ALL_CATEGORIES) {
    if (raw.includes(c)) return c;
  }
  return null;
}
