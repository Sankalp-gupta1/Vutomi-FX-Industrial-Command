import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { startTestDatabase } from "../tests/database";

// Runs a built API, independent worker processes and an isolated database in one local test.
const children: ChildProcess[] = [];
const origin = "http://127.0.0.1:3100";
let diagnostic = "";
function launch(args: string[], extra: Record<string, string> = {}) {
  const child = spawn(process.execPath, args, {
    env: { ...process.env, APP_URL: origin, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout?.on("data", (c) => {
    diagnostic = (diagnostic + c.toString()).slice(-12000);
  });
  child.stderr?.on("data", (c) => {
    diagnostic = (diagnostic + c.toString()).slice(-12000);
  });
  return child;
}
async function request(
  path: string,
  method = "GET",
  payload?: unknown,
  cookie = "",
  extra: Record<string, string> = {},
) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      origin,
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...extra,
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
    headers: response.headers,
  };
}
async function until<T>(
  work: () => Promise<T>,
  done: (v: T) => boolean,
  timeoutMs = 20000,
) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const result = await work();
      if (done(result)) return result;
    } catch {}
    await delay(150);
  }
  throw new Error("Timed out waiting for an expected service state");
}
async function main() {
  const cleanup = await startTestDatabase(false);
  try {
    for (let i = 0; i < 2; i++) {
      const migration = launch(["--import", "tsx", "scripts/migrate.ts"]);
      const [code] = await once(migration, "exit");
      assert.equal(code, 0, "Migration should apply and then be a no-op");
    }
    launch([
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3100",
    ]);
    await until(
      () => request("/api/health"),
      (r) => r.status === 200,
    );
    assert.equal((await request("/api/jobs")).status, 401);
    const password = crypto.randomBytes(24).toString("base64url");
    const a = await request("/api/auth/register", "POST", {
      name: "Smoke reviewer",
      email: "reviewer@example.test",
      password,
    });
    const b = await request("/api/auth/register", "POST", {
      name: "Other reviewer",
      email: "other@example.test",
      password,
    });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.ok(a.cookie);
    assert.match(a.headers.get("set-cookie")!, /HttpOnly/i);
    assert.match(a.headers.get("set-cookie")!, /SameSite=lax/i);
    assert.equal(
      (
        await request("/api/auth/login", "POST", {
          email: "reviewer@example.test",
          password: "wrong-password",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request("/api/auth/login", "POST", {
          email: "reviewer@example.test",
          password,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(
          "/api/jobs",
          "POST",
          { name: "Invalid", endpoint: "http://localhost" },
          a.cookie,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await request(
          "/api/jobs",
          "POST",
          { name: "Cross-site", endpoint: "demo://success" },
          a.cookie,
          { origin: "https://other.example.test" },
        )
      ).status,
      403,
    );
    const made = await request(
      "/api/jobs",
      "POST",
      { name: "Weekly export", endpoint: "demo://success" },
      a.cookie,
    );
    assert.equal(made.status, 201);
    const job = made.data.job;
    assert.equal(
      (await request(`/api/jobs/${job.id}`, "GET", undefined, b.cookie)).status,
      404,
    );
    const run = await request(
      `/api/jobs/${job.id}/run`,
      "POST",
      { idempotencyKey: "http-smoke-run" },
      a.cookie,
    );
    assert.equal(run.status, 202);
    assert.equal(run.data.execution.status, "queued");
    const duplicate = await request(
      `/api/jobs/${job.id}/run`,
      "POST",
      { idempotencyKey: "http-smoke-run" },
      a.cookie,
    );
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.data.execution.id, run.data.execution.id);
    assert.equal(
      (
        await request(
          `/api/executions/${run.data.execution.id}`,
          "GET",
          undefined,
          b.cookie,
        )
      ).status,
      404,
    );
    launch(["--import", "tsx", "worker/worker.ts"], {
      WORKER_ID: "smoke-worker-a",
    });
    launch(["--import", "tsx", "worker/worker.ts"], {
      WORKER_ID: "smoke-worker-b",
    });
    const finished = await until(
      () =>
        request(
          `/api/executions/${run.data.execution.id}`,
          "GET",
          undefined,
          a.cookie,
        ),
      (r) => r.data.execution?.status === "succeeded",
    );
    assert.equal(finished.data.execution.attempts.length, 1);
    assert.ok(finished.data.execution.logs.length >= 3);
    const flaky = await request(
      "/api/jobs",
      "POST",
      { name: "Recovering export", endpoint: "demo://flaky", retryLimit: 2 },
      a.cookie,
    );
    const flakyRun = await request(
      `/api/jobs/${flaky.data.job.id}/run`,
      "POST",
      { idempotencyKey: "flaky-smoke-run" },
      a.cookie,
    );
    const recovered = await until(
      () =>
        request(
          `/api/executions/${flakyRun.data.execution.id}`,
          "GET",
          undefined,
          a.cookie,
        ),
      (r) => r.data.execution?.status === "succeeded",
    );
    assert.equal(recovered.data.execution.attempts.length, 3);
    const failure = await request(
      "/api/jobs",
      "POST",
      {
        name: "Timeout example",
        endpoint: "demo://timeout",
        retryLimit: 0,
        timeoutMs: 1000,
      },
      a.cookie,
    );
    const failedRun = await request(
      `/api/jobs/${failure.data.job.id}/run`,
      "POST",
      { idempotencyKey: "timeout-smoke-run" },
      a.cookie,
    );
    const failed = await until(
      () =>
        request(
          `/api/executions/${failedRun.data.execution.id}`,
          "GET",
          undefined,
          a.cookie,
        ),
      (r) => r.data.execution?.status === "failed",
    );
    assert.equal(failed.data.execution.errorCode, "TIMEOUT");
    const fixed = await request(
      `/api/jobs/${failure.data.job.id}`,
      "PATCH",
      { endpoint: "demo://success", version: 1 },
      a.cookie,
    );
    assert.equal(fixed.status, 200);
    assert.equal(
      (
        await request(
          `/api/jobs/${failure.data.job.id}`,
          "PATCH",
          { name: "Stale edit", version: 1 },
          a.cookie,
        )
      ).status,
      409,
    );
    const retry = await request(
      `/api/executions/${failedRun.data.execution.id}/retry`,
      "POST",
      { idempotencyKey: "retry-smoke-run" },
      a.cookie,
    );
    assert.equal(retry.status, 202);
    assert.equal(retry.data.execution.retryOfId, failedRun.data.execution.id);
    await until(
      () =>
        request(
          `/api/executions/${retry.data.execution.id}`,
          "GET",
          undefined,
          a.cookie,
        ),
      (r) => r.data.execution?.status === "succeeded",
    );
    const health = await request("/api/system", "GET", undefined, a.cookie);
    assert.equal(
      health.data.workers.filter(
        (w: { status: string }) => w.status !== "offline",
      ).length,
      2,
    );
    assert.equal((await request("/api/openapi")).data.openapi, "3.0.3");
    await request("/api/auth/logout", "POST", {}, a.cookie);
    assert.equal(
      (await request("/api/me", "GET", undefined, a.cookie)).status,
      401,
    );
    console.log(
      "PASS: migration replay, auth, ownership, CSRF, validation, asynchronous acceptance, deduplication, two workers, success, automatic retry, timeout, edits, manual retry, history and logout.",
    );
  } finally {
    await Promise.all(
      children
        .filter((c) => c.exitCode === null)
        .map(async (c) => {
          c.kill("SIGTERM");
          await Promise.race([once(c, "exit"), delay(5000)]);
          if (c.exitCode === null) c.kill("SIGKILL");
        }),
    );
    await cleanup();
  }
}
main().catch((error) => {
  console.error(error);
  console.error(diagnostic);
  process.exitCode = 1;
});
