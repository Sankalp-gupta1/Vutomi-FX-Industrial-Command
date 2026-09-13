import crypto from "node:crypto";
import fs from "node:fs/promises";
import { Pool } from "pg";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { closeDb, query } from "../lib/db";

export const nativePostgres = Boolean(process.env.TEST_DATABASE_URL);

// Every test run gets its own schema or in-memory database. Never truncate a user's database.
export async function startTestDatabase(applySchema = true) {
  const previous = process.env.DATABASE_URL;
  let cleanup: () => Promise<void>;
  if (process.env.TEST_DATABASE_URL) {
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = `relay_test_${crypto.randomBytes(8).toString("hex")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set("options", `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    cleanup = async () => {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    };
  } else {
    const db = await PGlite.create();
    const server = new PGLiteSocketServer({
      db,
      port: 0,
      host: "127.0.0.1",
      maxConnections: 10,
    });
    await server.start();
    process.env.DATABASE_URL = `postgresql://postgres:postgres@${server.getServerConn()}/postgres`;
    cleanup = async () => {
      await server.stop();
      await db.close();
    };
  }
  if (applySchema)
    await query(
      await fs.readFile(
        new URL("../migrations/001_initial.sql", import.meta.url),
        "utf8",
      ),
    );
  return async () => {
    await closeDb();
    await cleanup();
    if (previous) process.env.DATABASE_URL = previous;
    else delete process.env.DATABASE_URL;
  };
}
