import { type VercelConfig } from "@vercel/config/v1";

// Vercel project configuration. Replaces vercel.json.
// https://vercel.com/docs/project-configuration/vercel-ts
export const config: VercelConfig = {
  framework: "nextjs",
  // Vercel Cron Jobs:
  // - Hobby plan minimum interval: daily.
  // - Pro plan minimum interval: 1 minute.
  // We schedule every 5 minutes ("*/5 * * * *"); on Hobby this falls back
  // to "first run of each day" — see README.md for details.
  crons: [
    {
      path: "/api/cron/poll",
      schedule: "*/5 * * * *",
    },
  ],
};

export default config;
