import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { mkdir } from "node:fs/promises";

async function start() {
  await mkdir("./data", { recursive: true });
  const db = await PGlite.create("./data/dev-postgres");
  const server = new PGLiteSocketServer({
    db,
    port: 5434,
    host: "127.0.0.1",
    maxConnections: 30,
  });
  await server.start();
  console.log(
    "Development database ready on 127.0.0.1:5434. See README for DATABASE_URL.",
  );
  const stop = async () => {
    await server.stop();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}
start().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
