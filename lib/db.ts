import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { logError } from "./logger";

let pool: Pool | undefined;
export function getPool() {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is not configured. See README.md.");
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 20000,
      statement_timeout: 10000,
      idle_in_transaction_session_timeout: 15000,
    });
    // PostgreSQL can disconnect an idle pooled client during an outage.
    pool.on("error", (error) =>
      logError("database.idle_connection_error", error),
    );
  }
  return pool;
}
export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
) {
  return getPool().query<T>(sql, params);
}
export async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
export async function closeDb() {
  await pool?.end();
  pool = undefined;
}
