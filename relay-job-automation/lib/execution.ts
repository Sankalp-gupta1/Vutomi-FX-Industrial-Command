import crypto from "node:crypto";
import { query, transaction } from "./db";
import { addLog, snapshotJob } from "./repository";
import { nextScheduledAt } from "./validation";
import { runTarget, type TargetConfig, type TargetResult } from "./target";
import { logEvent } from "./logger";

export type ClaimedRun = {
  id: string;
  job_id: string;
  user_id: string;
  snapshot: TargetConfig;
  attempt: number;
  max_attempts: number;
  lease_token: string;
  worker_id: string;
};
const leaseSeconds = 45;
export const retryDelayMs = (attempt: number, jitter = Math.random()) =>
  Math.min(30000, 1000 * 2 ** (attempt - 1)) + Math.floor(jitter * 400);
export async function heartbeat(
  workerId: string,
  executionId?: string,
  token?: string,
) {
  return transaction(async (c) => {
    if (executionId) {
      const owned = await c.query(
        `UPDATE executions SET lease_until=now()+make_interval(secs=>$3)
        WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now() RETURNING id`,
        [executionId, token, leaseSeconds],
      );
      if (!owned.rowCount) return false;
    }
    await c.query(
      `INSERT INTO workers(id,status,execution_id) VALUES($1,$2,$3)
      ON CONFLICT(id) DO UPDATE SET heartbeat_at=now(),status=excluded.status,execution_id=excluded.execution_id`,
      [workerId, executionId ? "busy" : "idle", executionId ?? null],
    );
    return true;
  });
}
export async function claimNext(workerId: string): Promise<ClaimedRun | null> {
  return transaction(async (c) => {
    const selected =
      await c.query(`SELECT id FROM executions WHERE status IN ('queued','retry_wait') AND available_at<=now()
      ORDER BY available_at,queued_at,id FOR UPDATE SKIP LOCKED LIMIT 1`);
    if (!selected.rows[0]) return null;
    const token = crypto.randomUUID();
    const result = await c.query(
      `UPDATE executions SET status='running',attempt=attempt+1,started_at=coalesce(started_at,now()),
      worker_id=$2,lease_token=$3,lease_until=now()+make_interval(secs=>$4)
      WHERE id=$1 RETURNING *`,
      [selected.rows[0].id, workerId, token, leaseSeconds],
    );
    const e = result.rows[0] as ClaimedRun;
    await c.query(
      "INSERT INTO attempts(execution_id,number,lease_token,worker_id) VALUES($1,$2,$3,$4)",
      [e.id, e.attempt, token, workerId],
    );
    await c.query(
      `INSERT INTO workers(id,status,execution_id) VALUES($1,'busy',$2)
      ON CONFLICT(id) DO UPDATE SET heartbeat_at=now(),status='busy',execution_id=$2`,
      [workerId, e.id],
    );
    await addLog(
      c,
      e.id,
      "info",
      `Attempt ${e.attempt}/${e.max_attempts} claimed by ${workerId}.`,
    );
    return e;
  });
}
export async function completeAttempt(
  e: ClaimedRun,
  result: TargetResult,
  durationMs: number,
) {
  return transaction(async (c) => {
    const row = (
      await c.query(
        `SELECT * FROM executions WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now() FOR UPDATE`,
        [e.id, e.lease_token],
      )
    ).rows[0];
    if (!row) return false; // The lease is a fencing token: stale workers cannot commit.
    const retry = !result.ok && result.retryable && e.attempt < e.max_attempts;
    const state = result.ok ? "succeeded" : retry ? "retry_wait" : "failed";
    const wait = retry ? retryDelayMs(e.attempt) : 0;
    await c.query(
      `UPDATE attempts SET outcome=$3,finished_at=now(),duration_ms=$4,response_code=$5,error_code=$6,error_message=$7
      WHERE execution_id=$1 AND number=$2`,
      [
        e.id,
        e.attempt,
        result.ok ? "succeeded" : "failed",
        durationMs,
        result.responseCode ?? null,
        result.errorCode ?? null,
        result.errorMessage ?? null,
      ],
    );
    await c.query(
      `UPDATE executions SET status=$2,available_at=now()+$3*interval '1 millisecond',
      finished_at=CASE WHEN $2='retry_wait' THEN NULL ELSE now() END,duration_ms=$4,response_code=$5,error_code=$6,
      error_message=$7,output=$8,lease_token=NULL,lease_until=NULL WHERE id=$1`,
      [
        e.id,
        state,
        wait,
        durationMs,
        result.responseCode ?? null,
        result.errorCode ?? null,
        result.errorMessage ?? null,
        result.output ?? null,
      ],
    );
    await addLog(
      c,
      e.id,
      result.ok ? "info" : "error",
      result.ok
        ? `Target completed with HTTP ${result.responseCode ?? 200}.`
        : (result.errorMessage ?? "Attempt failed."),
    );
    if (retry)
      await addLog(
        c,
        e.id,
        "warn",
        `Retry ${e.attempt + 1}/${e.max_attempts} is due in ${wait}ms.`,
      );
    if (!retry)
      await c.query("UPDATE jobs SET last_run_at=now() WHERE id=$1", [
        e.job_id,
      ]);
    await c.query(
      "UPDATE workers SET heartbeat_at=now(),status='idle',execution_id=NULL,completed_count=completed_count+1 WHERE id=$1",
      [e.worker_id],
    );
    logEvent("attempt.finished", {
      executionId: e.id,
      attempt: e.attempt,
      status: state,
      durationMs,
    });
    return true;
  });
}
export async function runOne(workerId: string) {
  const e = await claimNext(workerId);
  if (!e) return false;
  const lost = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const renew = async () => {
    try {
      if (!(await heartbeat(workerId, e.id, e.lease_token))) lost.abort();
    } catch {
      lost.abort();
    }
    if (!lost.signal.aborted) timer = setTimeout(renew, 10000);
  };
  timer = setTimeout(renew, 10000);
  const start = Date.now();
  try {
    const result = await runTarget(e.snapshot, e.id, e.attempt, lost.signal);
    await completeAttempt(e, result, Date.now() - start);
  } finally {
    clearTimeout(timer);
    lost.abort();
  }
  return true;
}
export async function recoverExpired() {
  return transaction(async (c) => {
    const expired = await c.query(
      "SELECT * FROM executions WHERE status='running' AND lease_until<=now() FOR UPDATE SKIP LOCKED LIMIT 100",
    );
    for (const e of expired.rows) {
      const retry = e.attempt < e.max_attempts;
      await c.query(
        `UPDATE attempts SET outcome='lease_expired',finished_at=now(),error_code='LEASE_EXPIRED',
        error_message='Worker stopped renewing its lease. External outcome is unknown.' WHERE execution_id=$1 AND number=$2`,
        [e.id, e.attempt],
      );
      await c.query(
        `UPDATE executions SET status=$2,lease_token=NULL,lease_until=NULL,available_at=now()+interval '1 second',
        error_code='LEASE_EXPIRED',error_message='Worker lease expired. The target may already have processed the request.',
        finished_at=CASE WHEN $2='failed' THEN now() ELSE NULL END WHERE id=$1`,
        [e.id, retry ? "retry_wait" : "failed"],
      );
      if (!retry)
        await c.query("UPDATE jobs SET last_run_at=now() WHERE id=$1", [
          e.job_id,
        ]);
      await addLog(
        c,
        e.id,
        "warn",
        retry
          ? "Worker lease expired. Recovery queued another attempt."
          : "Worker lease expired and no attempts remain. Check the target before retrying manually.",
      );
    }
    return expired.rowCount;
  });
}
export async function enqueueDueJobs() {
  return transaction(async (c) => {
    const due =
      await c.query(`SELECT * FROM jobs WHERE deleted_at IS NULL AND status='active' AND next_run_at<=now()
      ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT 100`);
    for (const j of due.rows) {
      const existing = await c.query(
        "SELECT id FROM executions WHERE job_id=$1 AND status IN ('queued','running','retry_wait')",
        [j.id],
      );
      if (!existing.rowCount) {
        const id = crypto.randomUUID();
        await c.query(
          `INSERT INTO executions(id,job_id,user_id,snapshot,trigger,max_attempts) VALUES($1,$2,$3,$4,'schedule',$5)`,
          [
            id,
            j.id,
            j.user_id,
            JSON.stringify(snapshotJob(j)),
            j.retry_limit + 1,
          ],
        );
        await addLog(
          c,
          id,
          "info",
          `Scheduled run accepted. Due slot: ${new Date(j.next_run_at).toISOString()}.`,
        );
      }
      // Coalesce missed slots and skip overlaps; never replay a backlog of external calls.
      await c.query("UPDATE jobs SET next_run_at=$2 WHERE id=$1", [
        j.id,
        nextScheduledAt(j.schedule),
      ]);
    }
    return due.rowCount;
  });
}
export async function maintainQueue() {
  await recoverExpired();
  await enqueueDueJobs();
  await query("DELETE FROM rate_limits WHERE bucket<$1", [
    Math.floor(Date.now() / 60000) - 1440,
  ]);
  await query("DELETE FROM sessions WHERE expires_at<now()");
}
