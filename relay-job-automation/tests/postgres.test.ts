import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query, getPool } from "../lib/db";
import {
  createJob,
  updateJob,
  enqueue,
  getExecutionForUser,
  listJobsForUser,
  cancelExecution,
  archiveJob,
  getHealth,
} from "../lib/repository";
import {
  claimNext,
  completeAttempt,
  heartbeat,
  recoverExpired,
  enqueueDueJobs,
  runOne,
} from "../lib/execution";
import {
  createSession,
  destroySession,
  userForToken,
  hashToken,
  rateLimit,
} from "../lib/auth";
import { jobSchema } from "../lib/validation";
import { nativePostgres, startTestDatabase } from "./database";

let cleanup: () => Promise<void>;
const owner = crypto.randomUUID(),
  other = crypto.randomUUID();
const success = {
  ok: true,
  retryable: false,
  responseCode: 200,
  output: "done",
};
const failure = {
  ok: false,
  retryable: true,
  responseCode: 503,
  errorCode: "HTTP_503",
  errorMessage: "Service unavailable",
};
async function job(overrides: Record<string, unknown> = {}) {
  return (await createJob(
    owner,
    jobSchema.parse({
      name: "Payroll export",
      endpoint: "demo://success",
      ...overrides,
    }),
  ))!;
}
async function makeDue(id: string) {
  await query(
    "UPDATE executions SET available_at=now()-interval '1 second' WHERE id=$1",
    [id],
  );
}
beforeAll(async () => {
  cleanup = await startTestDatabase();
  await query(
    "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4),($5,$6,$7,$8)",
    [
      owner,
      "owner@example.test",
      "Owner",
      "unused",
      other,
      "other@example.test",
      "Other",
      "unused",
    ],
  );
}, 30000);
afterAll(async () => {
  await cleanup?.();
});

describe("durable queue and ownership", () => {
  it("returns the same execution for repeated requests, including after completion", async () => {
    const j = await job();
    const first = await enqueue(owner, j.id, "request-001");
    expect(first.created).toBe(true);
    expect(await enqueue(owner, j.id, "request-001")).toEqual({
      id: first.id,
      created: false,
    });
    expect(await enqueue(owner, j.id, "different-key")).toEqual({
      id: first.id,
      created: false,
    });
    const claim = (await claimNext("test-worker"))!;
    expect(claim.id).toBe(first.id);
    await completeAttempt(claim, success, 8);
    expect(await enqueue(owner, j.id, "request-001")).toEqual({
      id: first.id,
      created: false,
    });
    expect((await getExecutionForUser(first.id, owner))?.attempts).toHaveLength(
      1,
    );
  });
  it("rejects reusing a key for another job and leaves no extra execution", async () => {
    const first = await job(),
      second = await job();
    const accepted = await enqueue(owner, first.id, "conflicting-key");
    await expect(
      enqueue(owner, second.id, "conflicting-key"),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await query("SELECT id FROM executions WHERE job_id=$1", [second.id]))
        .rowCount,
    ).toBe(0);
    await cancelExecution(accepted.id, owner);
  });
  it("enforces tenant ownership for jobs, executions, logs, edits and cancellation", async () => {
    const j = await job();
    const run = await enqueue(owner, j.id, "private-run");
    expect(await getExecutionForUser(run.id, other)).toBeNull();
    expect(await listJobsForUser(other)).toEqual([]);
    await expect(enqueue(other, j.id, "stolen-key")).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      updateJob(j.id, other, { name: "Changed", version: 1 }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(cancelExecution(run.id, other)).rejects.toMatchObject({
      status: 404,
    });
    await cancelExecution(run.id, owner);
  });
  it("keeps a snapshot when the job is edited and rejects stale versions", async () => {
    const j = await job();
    const run = await enqueue(owner, j.id, "snapshot-key");
    await updateJob(j.id, owner, {
      version: j.version,
      name: "Revised export",
      endpoint: "demo://failure",
    });
    await expect(
      updateJob(j.id, owner, { version: j.version, name: "Stale export" }),
    ).rejects.toMatchObject({ status: 409 });
    const claim = (await claimNext("snapshot-worker"))!;
    expect(claim.snapshot.name).toBe("Payroll export");
    expect(claim.snapshot.endpoint).toBe("demo://success");
    await completeAttempt(claim, success, 3);
    expect((await getExecutionForUser(run.id, owner))?.jobName).toBe(
      "Payroll export",
    );
  });
  it("retries with a bounded budget, preserves every attempt and supports manual retry", async () => {
    const j = await job({ retryLimit: 1 });
    const run = await enqueue(owner, j.id, "retry-budget");
    const a = (await claimNext("retry-worker"))!;
    await completeAttempt(a, failure, 7);
    expect((await getExecutionForUser(run.id, owner))?.status).toBe(
      "retry_wait",
    );
    expect(await claimNext("early-worker")).toBeNull();
    await makeDue(run.id);
    await completeAttempt((await claimNext("retry-worker"))!, failure, 9);
    const done = (await getExecutionForUser(run.id, owner))!;
    expect(done.status).toBe("failed");
    expect(done.attempts).toHaveLength(2);
    expect(done.logs.some((l) => l.message.includes("Retry"))).toBe(true);
    const retried = await enqueue(owner, j.id, "manual-retry-key", run.id);
    const next = (await getExecutionForUser(retried.id, owner))!;
    expect(next.retryOfId).toBe(run.id);
    expect(next.attempt).toBe(0);
    await cancelExecution(retried.id, owner);
  });
  it("does not retry a permanent failure even with budget remaining", async () => {
    const j = await job();
    const run = await enqueue(owner, j.id, "permanent-error");
    await completeAttempt(
      (await claimNext("permanent-worker"))!,
      { ...failure, retryable: false, responseCode: 400 },
      4,
    );
    expect((await getExecutionForUser(run.id, owner))?.status).toBe("failed");
  });
  it("recovers an expired lease and fences the stale worker result", async () => {
    const j = await job();
    const run = await enqueue(owner, j.id, "crash-recovery");
    const old = (await claimNext("crashed-worker"))!;
    await query(
      "UPDATE executions SET lease_until=now()-interval '1 second' WHERE id=$1",
      [run.id],
    );
    expect(await heartbeat("crashed-worker", run.id, old.lease_token)).toBe(
      false,
    );
    expect(await recoverExpired()).toBe(1);
    await makeDue(run.id);
    const replacement = (await claimNext("replacement-worker"))!;
    expect(replacement.lease_token).not.toBe(old.lease_token);
    expect(await completeAttempt(old, success, 5)).toBe(false);
    expect(await completeAttempt(replacement, success, 8)).toBe(true);
    const done = (await getExecutionForUser(run.id, owner))!;
    expect(done.status).toBe("succeeded");
    expect(done.attempts[0].outcome).toBe("lease_expired");
  });
  it("fails a crashed final attempt instead of retrying forever", async () => {
    const j = await job({ retryLimit: 0 });
    const run = await enqueue(owner, j.id, "crash-final");
    await claimNext("last-worker");
    await query(
      "UPDATE executions SET lease_until=now()-interval '1 second' WHERE id=$1",
      [run.id],
    );
    await recoverExpired();
    expect((await getExecutionForUser(run.id, owner))?.status).toBe("failed");
  });
  it("allows cancellation before dispatch and preserves history after archive", async () => {
    const j = await job();
    const run = await enqueue(owner, j.id, "cancel-key");
    await cancelExecution(run.id, owner);
    expect(await claimNext("cancel-worker")).toBeNull();
    await archiveJob(j.id, owner, j.version);
    expect((await listJobsForUser(owner)).some((x) => x.id === j.id)).toBe(
      false,
    );
    expect((await getExecutionForUser(run.id, owner))?.status).toBe(
      "cancelled",
    );
    await expect(cancelExecution(run.id, owner)).rejects.toMatchObject({
      status: 409,
    });
  });
  it("does not pretend to cancel an HTTP request already running", async () => {
    const j = await job();
    const run = await enqueue(owner, j.id, "running-cancel");
    const claim = (await claimNext("active-worker"))!;
    await expect(cancelExecution(run.id, owner)).rejects.toMatchObject({
      status: 409,
    });
    await completeAttempt(claim, success, 2);
  });
  it("schedules one run, coalesces missed slots and skips overlap", async () => {
    const j = await job({ schedule: "Every 15 minutes" });
    await query(
      "UPDATE jobs SET next_run_at=now()-interval '1 day' WHERE id=$1",
      [j.id],
    );
    await enqueueDueJobs();
    await enqueueDueJobs();
    const runs = await query("SELECT * FROM executions WHERE job_id=$1", [
      j.id,
    ]);
    expect(runs.rowCount).toBe(1);
    expect(runs.rows[0].trigger).toBe("schedule");
    await query(
      "UPDATE jobs SET next_run_at=now()-interval '1 second' WHERE id=$1",
      [j.id],
    );
    await enqueueDueJobs();
    expect(
      (await query("SELECT id FROM executions WHERE job_id=$1", [j.id]))
        .rowCount,
    ).toBe(1);
    await cancelExecution(runs.rows[0].id, owner);
    await updateJob(j.id, owner, { status: "paused", version: 1 });
    await expect(enqueue(owner, j.id, "paused-request")).rejects.toMatchObject({
      status: 409,
    });
  });
  it("runs the target through the actual worker function and records the output", async () => {
    const j = await job();
    const run = await enqueue(owner, j.id, "target-end-to-end");
    expect(await runOne("real-target-worker")).toBe(true);
    const done = (await getExecutionForUser(run.id, owner))!;
    expect(done.status).toBe("succeeded");
    expect(done.output).toContain(run.id);
  });
  it("stores only session hashes, checks expiration, and invalidates logout", async () => {
    const session = await createSession(owner);
    const rows = await query(
      "SELECT token_hash FROM sessions WHERE user_id=$1",
      [owner],
    );
    expect(rows.rows[0].token_hash).toBe(hashToken(session.token));
    expect((await userForToken(session.token))?.id).toBe(owner);
    await query(
      "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
      [hashToken(session.token)],
    );
    expect(await userForToken(session.token)).toBeNull();
    await destroySession(session.token);
    expect((await query("SELECT * FROM sessions")).rowCount).toBe(0);
  });
  it("enforces shared rate limits and detects a stale worker heartbeat", async () => {
    await rateLimit("limit-test", 1);
    await expect(rateLimit("limit-test", 1)).rejects.toMatchObject({
      status: 429,
    });
    await heartbeat("stale-worker");
    await query(
      "UPDATE workers SET heartbeat_at=now()-interval '1 minute' WHERE id='stale-worker'",
    );
    expect(
      (await getHealth(owner)).workers.find((w) => w.id === "stale-worker")
        ?.status,
    ).toBe("offline");
  });
});

// PGlite has a single backend. These tests require independently locked PostgreSQL sessions.
describe.skipIf(!nativePostgres)("native PostgreSQL concurrency", () => {
  it("SKIP LOCKED lets a second worker claim another job without waiting", async () => {
    const j1 = await job(),
      j2 = await job();
    const a = await enqueue(owner, j1.id, "locked-first"),
      b = await enqueue(owner, j2.id, "unlocked-second");
    const lock = await getPool().connect();
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT id FROM executions WHERE id=$1 FOR UPDATE", [
        a.id,
      ]);
      const second = (await claimNext("parallel-worker"))!;
      expect(second.id).toBe(b.id);
      await completeAttempt(second, success, 1);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
    }
    await cancelExecution(a.id, owner);
  });
  it("ten competing requests and workers produce only one claimed attempt", async () => {
    const j = await job();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        enqueue(owner, j.id, `parallel-request-${i}`),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const claims = await Promise.all(
      Array.from({ length: 10 }, (_, i) => claimNext(`parallel-${i}`)),
    );
    const winners = claims.filter((c) => c !== null);
    expect(winners).toHaveLength(1);
    await completeAttempt(winners[0]!, success, 3);
  });
  it("serializes a key across different jobs and rejects exactly one request", async () => {
    const j1 = await job(),
      j2 = await job();
    const results = await Promise.allSettled([
      enqueue(owner, j1.id, "cross-job-race"),
      enqueue(owner, j2.id, "cross-job-race"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult;
    expect(loser.reason.status).toBe(409);
    const winner = results.find(
      (r) => r.status === "fulfilled",
    ) as PromiseFulfilledResult<{ id: string }>;
    await cancelExecution(winner.value.id, owner);
  });
  it("accepts only one simultaneous edit at a given version", async () => {
    const j = await job();
    const results = await Promise.allSettled([
      updateJob(j.id, owner, { name: "Edit A", version: 1 }),
      updateJob(j.id, owner, { name: "Edit B", version: 1 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
        .reason.status,
    ).toBe(409);
  });
  it("two schedulers do not enqueue the same due job twice", async () => {
    const j = await job({ schedule: "Every hour" });
    await query(
      "UPDATE jobs SET next_run_at=now()-interval '1 minute' WHERE id=$1",
      [j.id],
    );
    await Promise.all([enqueueDueJobs(), enqueueDueJobs()]);
    const rows = await query("SELECT id FROM executions WHERE job_id=$1", [
      j.id,
    ]);
    expect(rows.rowCount).toBe(1);
    await cancelExecution(rows.rows[0].id, owner);
  });
});
