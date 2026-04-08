import { Pool } from "pg";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required");
    pool = new Pool({
      connectionString: url,
      max: 10,
      idleTimeoutMillis: 30000,
      // Supabase connection pooler uses a self-signed cert in the chain;
      // rejectUnauthorized: false allows SSL without verifying the CA.
      ssl: { rejectUnauthorized: false },
    });
    pool.on("error", (err) => console.error("[db] pool error:", err));
  }
  return pool;
}
