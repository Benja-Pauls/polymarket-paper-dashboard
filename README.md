# Polymarket Paper Dashboard

Paper-money dashboard for Polymarket prediction-market trading strategies. The cron polls Goldsky every 5 minutes for new on-chain trades and applies each strategy's filter to virtual capital.

> **No real money is ever placed.** This dashboard tracks fake-money positions only.

## Stack

- Next.js 16 (App Router), TypeScript, Tailwind v4
- shadcn/ui, Recharts, Drizzle ORM
- Neon Postgres (via Vercel Marketplace)
- Vercel Cron (every 5 min, Pro plan)

## Pages

- `/` — Model leaderboard (one card per strategy with sparkline + KPIs)
- `/models/[strategyId]` — Wealth curve + tabs (open / signals / closed / tripwires)
- `/models/[strategyId]/markets/[marketId]` — Per-market detail

## Local development

```bash
# 1. Install deps
pnpm install

# 2. Pull env vars from Vercel (after `vercel link`)
vercel env pull .env.local

# 3. Push the schema to your Neon DB
pnpm db:push

# 4. Generate the seed payload (reads parquet from sibling research repo)
source ../Stock_Portfolio/.venv/bin/activate
pnpm export-seed   # writes scripts/seed_data.json (~0.4 MB)

# 5. Seed strategy + watched markets
pnpm seed

# 6. Run dev server
pnpm dev
```

## Deployment

```bash
gh repo create polymarket-paper-dashboard --public --source=. --remote=origin --push
vercel link
# Add a Neon Postgres integration via the Vercel dashboard or:
vercel storage create
vercel env pull .env.local
pnpm db:push        # apply schema to the new DB
pnpm export-seed    # generate seed_data.json
pnpm seed           # populate the DB
vercel deploy --prod
```

## Cron

Configured in both `vercel.ts` (preferred) and `vercel.json` (fallback). The schedule is `*/5 * * * *` (every 5 min). On Hobby this is downgraded to once-a-day; on Pro it runs every 5 min as configured.

The cron handler at `/api/cron/poll` is idempotent — running it twice does no harm because `(strategy_id, raw_trade_id)` is uniquely indexed on the `signals` table.

To trigger manually:

```bash
curl https://<your-domain>.vercel.app/api/cron/poll \
  -H "Authorization: Bearer $CRON_SECRET"
```

## Strategy

Currently seeded with one strategy: **`tighter_blanket_cap10_3day`**

- entry_price in [0.10, 0.40)
- at least 72h to resolution
- cap=10 bets per market chronologically
- only on tradeable_{geopolitical, political, corporate, crypto}
- $1,000 starting bankroll, $10 stake per bet
- 2% slippage baked in

This was post-forward-OOS-validated 2026-04-28 as a "Bar 1 floor" candidate (P5=+$16.7K on $5K bankroll, 100% positive bootstrap, top-1 conc 3.9%, 51 bets/mo).

## v0 / v1

This is **v0** — public read-only dashboard. **v1** will add auth (probably Clerk via Vercel Marketplace) for write operations like manually halting a strategy.

## Hard rules

- NO real-money trades, ever.
- No `.env*` is committed.
- Don't write to the sibling `polymarket-insider-detection/` directory.
