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
  ],
};

export default config;
