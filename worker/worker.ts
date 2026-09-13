import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { closeDb } from "../lib/db";
import { heartbeat, maintainQueue, runOne } from "../lib/execution";
import { logError, logEvent } from "../lib/logger";
const workerId =
  process.env.WORKER_ID || `worker-${crypto.randomUUID().slice(0, 8)}`;
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
async function start() {
  logEvent("worker.started", { workerId });
  while (!stopping) {
    try {
      await heartbeat(workerId);
      await maintainQueue();
      if (!(await runOne(workerId))) await delay(750);
    } catch (error) {
      logError("worker.cycle_failed", error, { workerId });
      await delay(3000); // A database outage must not discard queued work or spin a hot loop.
    }
  }
  await closeDb();
  logEvent("worker.stopped", { workerId });
}
start().catch((error) => {
  logError("worker.fatal", error);
  process.exitCode = 1;
});
