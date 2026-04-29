// One-shot seed for the paper-money dashboard.
//
// 1. Inserts (or upserts) the strategy `tighter_blanket_cap10_3day`.
// 2. Loads watched markets from scripts/seed_data.json (produced by
//    `scripts/export_seed.py`) and upserts them into the markets table.
//
// Usage:   pnpm seed
// Idempotent — safe to re-run.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import { strategies, markets } from "../src/lib/db/schema";
import { STRATEGY } from "../src/lib/strategy";

type SeedRow = {
  condition_id: string;
  question: string | null;
  category: string;
  resolution_timestamp: number | null;
  resolved: number;
  winner_outcome_idx: number | null;
  payouts: string[] | null;
  token_to_outcome: Record<string, number> | null;
};

type SeedFile = {
  generated_at: string;
  n_markets: number;
  n_with_token_map: number;
  watched_markets: SeedRow[];
};

async function main() {
  console.log("[seed] starting");
  const seedPath = join(process.cwd(), "scripts", "seed_data.json");
  let seed: SeedFile;
  try {
    seed = JSON.parse(readFileSync(seedPath, "utf8")) as SeedFile;
  } catch (e) {
    console.error(
      `[seed] could not read ${seedPath}. Run \`python scripts/export_seed.py\` first.`,
    );
    throw e;
  }
  console.log(
    `[seed] loaded ${seed.watched_markets.length.toLocaleString()} markets from ${seedPath} (generated_at ${seed.generated_at})`,
  );

  // 1. Upsert the strategy
  const existing = await db.execute(sql`select id, current_cash from strategies where id = ${STRATEGY.id}`);
  const isNew = (existing.rows ?? existing).length === 0;
  await db
    .insert(strategies)
    .values({
      id: STRATEGY.id,
      name: STRATEGY.name,
      description: STRATEGY.description,
      paramsJson: STRATEGY.params,
      startingBankroll: STRATEGY.startingBankroll,
      currentCash: STRATEGY.startingBankroll,
      stake: STRATEGY.stake,
      status: "active",
    })
    .onConflictDoUpdate({
      target: strategies.id,
      set: {
        description: STRATEGY.description,
        paramsJson: STRATEGY.params,
        stake: STRATEGY.stake,
        updatedAt: new Date(),
      },
    });
  console.log(
    `[seed] strategy ${STRATEGY.id} ${isNew ? "created" : "updated"} (bankroll $${STRATEGY.startingBankroll}, stake $${STRATEGY.stake})`,
  );

  // 2. Bulk upsert markets in batches (Postgres parameter limit ~65535)
  const BATCH = 500;
  let total = 0;
  for (let i = 0; i < seed.watched_markets.length; i += BATCH) {
    const slice = seed.watched_markets.slice(i, i + BATCH);
    await db
      .insert(markets)
      .values(
        slice.map((r) => ({
          conditionId: r.condition_id,
          questionText: r.question,
          category: r.category,
          resolutionTimestamp: r.resolution_timestamp,
          payoutsJson: r.payouts,
          resolved: r.resolved,
          winnerOutcomeIdx: r.winner_outcome_idx,
        })),
      )
      .onConflictDoUpdate({
        target: markets.conditionId,
        set: {
          questionText: sql`excluded.question_text`,
          category: sql`excluded.category`,
          updatedAt: new Date(),
        },
      });
    total += slice.length;
    if (i % 5000 === 0 || total === seed.watched_markets.length) {
      console.log(`[seed]   upserted ${total.toLocaleString()} / ${seed.watched_markets.length.toLocaleString()} markets`);
    }
  }

  console.log(`[seed] done. ${total} markets in DB.`);
}

main().catch((e) => {
  console.error("[seed] FAILED:", e);
  process.exit(1);
});
