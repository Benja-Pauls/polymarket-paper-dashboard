import { type VercelConfig } from "@vercel/config/v1";

// Vercel project configuration. Replaces vercel.json.
// https://vercel.com/docs/project-configuration/vercel-ts
export const config: VercelConfig = {
  framework: "nextjs",
  // Vercel Cron Jobs:
  //  - Hobby plan minimum interval: daily.
  //  - Pro plan minimum interval: 1 minute.
  //
  // For useful live paper-trading at "every 5 min" granularity, upgrade to
  // Pro and change `schedule` to "*/5 * * * *". The endpoint is idempotent;
  // the only thing that changes is how often cap-10 chronological filling
  // sees fresh trades.
  crons: [
    {
      path: "/api/cron/poll",
      // Once a day at 14:30 UTC. Hobby plan max frequency.
      // Bump to "*/5 * * * *" after upgrading to Pro.
      schedule: "30 14 * * *",
    },
  ],
};

export default config;
