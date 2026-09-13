import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { closeDb, transaction } from "../lib/db";
async function migrate() {
  const files = (await fs.readdir(path.join(process.cwd(), "migrations")))
    .filter((x) => x.endsWith(".sql"))
    .sort();
  await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(735412)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    for (const file of files) {
      const sql = await fs.readFile(
        path.join(process.cwd(), "migrations", file),
        "utf8",
      );
      const checksum = crypto.createHash("sha256").update(sql).digest("hex");
      const old = await client.query(
        "SELECT checksum FROM schema_migrations WHERE name=$1",
        [file],
      );
      if (old.rows[0]) {
        if (old.rows[0].checksum !== checksum)
          throw new Error(`Migration changed: ${file}`);
        continue;
      }
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (name,checksum) VALUES ($1,$2)",
        [file, checksum],
      );
      console.log(`Applied ${file}`);
    }
  });
}
migrate()
  .catch((error) => {
    console.error("Migration failed:", error.message);
    process.exitCode = 1;
  })
  .finally(closeDb);
