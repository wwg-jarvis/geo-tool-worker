import { Pool } from "pg";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required");
    pool = new Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30000 });
    pool.on("error", (err) => console.error("[db] pool error:", err));
  }
  return pool;
}
