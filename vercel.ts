import { type VercelConfig } from "@vercel/config/v1";

// Vercel project configuration. Replaces vercel.json.
// https://vercel.com/docs/project-configuration/vercel-ts
export const config: VercelConfig = {
  framework: "nextjs",
  // Vercel Cron Jobs:
  //  - Hobby plan minimum interval: daily.
  //  - Pro plan minimum interval: 1 minute.
  //
  // Pro plan unlocked 2026-04-29 evening. 15-min polling is enough granularity
  // for paper-trading; each invocation polls Goldsky for recent trades, applies
  // all active strategies' filters, and writes signals/positions to the DB.
  // The endpoint is idempotent — duplicate trades are deduped by trade_id.
  crons: [
    {
      path: "/api/cron/poll",
      // Every 15 minutes.
      schedule: "*/15 * * * *",
    },
    {
      // Sync OPEN markets from Polymarket Gamma + classify with static labels
      // and Claude Haiku 4.5. Required because Goldsky's Condition entity has
      // no concept of `endDate` — without this, every newly-tradeable market
      // has `resolution_timestamp = NULL` and every strategy skips with
      // "no resolution timestamp known".
      path: "/api/cron/sync-open-markets",
      // Every 1 hour. Each run processes up to 25K markets (Gamma has ~50K
      // open). The 1500 LLM-call cap means we backfill new markets across
      // multiple runs — hourly cadence keeps the LLM-needed backlog draining
      // and gives us ~24 chances/day to catch newly-resolved-far-future
      // markets that drifted into our DB via lazy-classify.
      schedule: "0 * * * *",
    },
    {
      // Daily skip-signal prune. Without it the signals table grows ~1.5M
      // rows / day at the current poll rate (10 strategies × ~1500 trades ×
      // 96 polls/day ≈ 1.4M rows/day) and hit the Neon Hobby 512MB cap on
      // 2026-04-30. Retention: 24h. Bet signals (FK-referenced by positions)
      // are never deleted.
      path: "/api/cron/prune-signals",
      // 06:00 UTC = 1 AM CST — quiet window between active polls.
      schedule: "0 6 * * *",
    },
  ],
};

export default config;
