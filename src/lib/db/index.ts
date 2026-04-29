import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

const databaseUrl =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL_UNPOOLED ||
  process.env.POSTGRES_URL_NON_POOLING;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is not set. Provision a Neon database via the Vercel Marketplace and pull env vars with `vercel env pull .env.local`.",
  );
}

const sql = neon(databaseUrl);
export const db = drizzle(sql, { schema, casing: "snake_case" });
export { schema };
