import { config as loadEnv } from "dotenv";
import { defineConfig } from "drizzle-kit";

// Load env from .env.local first (Vercel CLI writes here), then fall back
// to .env. Vercel-pulled `DATABASE_URL` is preferred over Postgres-prefix.
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  casing: "snake_case",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ||
      process.env.POSTGRES_URL ||
      process.env.DATABASE_URL_UNPOOLED ||
      "",
  },
});
