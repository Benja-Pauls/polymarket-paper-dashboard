/**
 * Undo: revert the bad sentinel resolution_timestamp = 0 from the broken
 * batch-conditionIds backfill. Set them back to NULL so the real fix (paginated
 * open list with no end-date cap) can populate them properly.
 */
import { neon } from "@neondatabase/serverless";

async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const sql = neon(dbUrl);

  const before = await sql`
    SELECT COUNT(*)::int as n FROM markets WHERE resolution_timestamp = 0
  `;
  console.log(`Markets with sentinel ts=0 before: ${before[0]?.n ?? 0}`);

  const r = await sql`
    UPDATE markets
    SET resolution_timestamp = NULL,
        updated_at = now()
    WHERE resolution_timestamp = 0
  `;
  console.log("Update done.", r);

  const after = await sql`
    SELECT COUNT(*)::int as n FROM markets WHERE resolution_timestamp = 0
  `;
  console.log(`Markets with sentinel ts=0 after: ${after[0]?.n ?? 0}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
