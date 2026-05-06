import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }

  const sql = neon(process.env.DATABASE_URL);

  // Required for generated `name_normalized` columns and pg_trgm GIN indexes.
  // Idempotent; safe to run on every migrate.
  await sql`CREATE EXTENSION IF NOT EXISTS unaccent`;
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`;

  // Drizzle's unaccent() call must be IMMUTABLE to be usable in a GENERATED column.
  // The stock unaccent() is STABLE. wrap it so the column definition is accepted.
  await sql`
    CREATE OR REPLACE FUNCTION immutable_unaccent(text)
    RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
    AS $$ SELECT unaccent('unaccent', $1) $$
  `;

  const db = drizzle(sql);

  console.log("running migrations...");
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
  console.log("migrations complete");

  // Trigram indexes for fuzzy search on clients.name_normalized and products.name_normalized.
  // Created separately because drizzle-kit doesn't emit GIN + gin_trgm_ops.
  await sql`
    CREATE INDEX IF NOT EXISTS clients_name_trgm_idx
    ON clients USING gin (name_normalized gin_trgm_ops)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS products_name_trgm_idx
    ON products USING gin (name_normalized gin_trgm_ops)
  `;
  console.log("trigram indexes ensured");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
