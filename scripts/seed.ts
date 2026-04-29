// One-shot seed for the paper-money dashboard.
//
// 1. Inserts (or upserts) each strategy in `STRATEGIES`.
// 2. Marks any id in `RETIRED_STRATEGY_IDS` as retired (status='retired'),
//    keeping its historical signals/positions for record.
// 3. Loads watched markets from scripts/seed_data.json (produced by
//    `scripts/export_seed.py`) and upserts them into the markets table.
// 4. Loads market catalysts from scripts/catalyst_data.json (produced by
//    `scripts/export_catalysts.py`) and upserts them into the
//    `market_catalysts` table. Used by `require_future_catalyst` strategies.
//
// Usage:   pnpm seed
// Idempotent — safe to re-run.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inArray, sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import {
  strategies,
  markets,
  marketCatalysts,
} from "../src/lib/db/schema";
import { STRATEGIES, RETIRED_STRATEGY_IDS } from "../src/lib/strategy";

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

type CatalystRow = {
  condition_id: string;
  catalyst_ts: number;
  catalyst_source: string | null;
  catalyst_confidence: string | null;
};

type CatalystFile = {
  generated_at: string;
  n_catalysts: number;
  catalysts: CatalystRow[];
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

  // 1. Upsert each active strategy
  for (const cfg of STRATEGIES) {
    const existing = await db.execute(
      sql`select id, current_cash, status from strategies where id = ${cfg.id}`,
    );
    const rows = (existing.rows ?? existing) as Array<Record<string, unknown>>;
    const isNew = rows.length === 0;
    await db
      .insert(strategies)
      .values({
        id: cfg.id,
        name: cfg.name,
        description: cfg.description,
        paramsJson: cfg.params as unknown as Record<string, unknown>,
        startingBankroll: cfg.startingBankroll,
        currentCash: cfg.startingBankroll,
        stake: cfg.stake,
        status: cfg.active ? "active" : "retired",
      })
      .onConflictDoUpdate({
        target: strategies.id,
        set: {
          name: cfg.name,
          description: cfg.description,
          paramsJson: cfg.params as unknown as Record<string, unknown>,
          stake: cfg.stake,
          // Don't overwrite currentCash on update — preserves accumulated P&L.
          status: cfg.active ? "active" : "retired",
          updatedAt: new Date(),
        },
      });
    console.log(
      `[seed]   strategy ${cfg.id} ${isNew ? "created" : "updated"} (status=${cfg.active ? "active" : "retired"}, bankroll $${cfg.startingBankroll}, stake $${cfg.stake})`,
    );
  }

  // 2. Retire predecessor strategies (keeps their data, stops new signals)
  if (RETIRED_STRATEGY_IDS.length > 0) {
    const result = await db
      .update(strategies)
      .set({
        status: "retired",
        haltReason: "deprecated by multi-strategy refactor",
        updatedAt: new Date(),
      })
      .where(inArray(strategies.id, RETIRED_STRATEGY_IDS))
      .returning({ id: strategies.id });
    if (result.length > 0) {
      console.log(`[seed]   retired predecessor strategies: ${result.map((r) => r.id).join(", ")}`);
    }
  }

  // 3. Bulk upsert markets in batches (Postgres parameter limit ~65535)
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
      console.log(
        `[seed]   upserted ${total.toLocaleString()} / ${seed.watched_markets.length.toLocaleString()} markets`,
      );
    }
  }

  // 4. Load catalysts from scripts/catalyst_data.json (optional).
  const catalystPath = join(process.cwd(), "scripts", "catalyst_data.json");
  let nCatalysts = 0;
  if (existsSync(catalystPath)) {
    let cat: CatalystFile;
    try {
      cat = JSON.parse(readFileSync(catalystPath, "utf8")) as CatalystFile;
    } catch (e) {
      console.error(
        `[seed] could not parse ${catalystPath}; skipping catalyst load.`,
        e,
      );
      cat = { generated_at: "", n_catalysts: 0, catalysts: [] };
    }
    console.log(
      `[seed] loaded ${cat.catalysts.length.toLocaleString()} catalyst rows from ${catalystPath} (generated_at ${cat.generated_at})`,
    );

    // Bulk upsert in batches.
    let catTotal = 0;
    for (let i = 0; i < cat.catalysts.length; i += BATCH) {
      const slice = cat.catalysts.slice(i, i + BATCH);
      await db
        .insert(marketCatalysts)
        .values(
          slice.map((r) => ({
            conditionId: r.condition_id,
            catalystTs: r.catalyst_ts,
            catalystSource: r.catalyst_source ?? null,
            catalystConfidence: r.catalyst_confidence ?? null,
          })),
        )
        .onConflictDoUpdate({
          target: marketCatalysts.conditionId,
          set: {
            catalystTs: sql`excluded.catalyst_ts`,
            catalystSource: sql`excluded.catalyst_source`,
            catalystConfidence: sql`excluded.catalyst_confidence`,
            updatedAt: new Date(),
          },
        });
      catTotal += slice.length;
      if (i % 5000 === 0 || catTotal === cat.catalysts.length) {
        console.log(
          `[seed]   upserted ${catTotal.toLocaleString()} / ${cat.catalysts.length.toLocaleString()} catalysts`,
        );
      }
    }
    nCatalysts = catTotal;
  } else {
    console.log(
      `[seed] no catalyst_data.json at ${catalystPath} — skipping catalyst load. Run \`python scripts/export_catalysts.py\` to populate.`,
    );
  }

  console.log(
    `[seed] done. ${total} markets, ${nCatalysts} catalysts in DB. ${STRATEGIES.length} strategies seeded.`,
  );
}

main().catch((e) => {
  console.error("[seed] FAILED:", e);
  process.exit(1);
});
