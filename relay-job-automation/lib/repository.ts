import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { query, transaction } from "./db";
import { AppError, assertFound } from "./errors";
import { nextScheduledAt, type JobInput } from "./validation";
import type { ExecutionDetail, ExecutionSummary, Job, Health } from "./types";

type Row = Record<string, any>; // SQL rows are mapped explicitly at the boundary.
const iso = (v: Date | string | null): string | null =>
  v ? new Date(v).toISOString() : null;
export function mapExecution(r: Row): ExecutionSummary {
  return {
    id: r.id,
    jobId: r.job_id,
    jobName: r.snapshot.name,
    status: r.status,
    trigger: r.trigger,
    attempt: r.attempt,
    maxAttempts: r.max_attempts,
    retryOfId: r.retry_of_id,
    queuedAt: iso(r.queued_at)!,
    availableAt: iso(r.available_at)!,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    durationMs: r.duration_ms,
    responseCode: r.response_code,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    output: r.output,
    workerId: r.worker_id,
  };
}
function mapJob(r: Row): Job {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    type: r.type,
    endpoint: r.endpoint,
    method: r.method,
    schedule: r.schedule,
    status: r.status,
    retryLimit: r.retry_limit,
    timeoutMs: r.timeout_ms,
    version: r.version,
    lastRunAt: iso(r.last_run_at),
    nextRunAt: iso(r.next_run_at),
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    latestExecution: r.latest ? mapExecution(r.latest) : null,
    executionCount: Number(r.execution_count || 0),
  };
}
export async function listJobsForUser(userId: string) {
  const result = await query(
    `SELECT j.*, (SELECT row_to_json(e) FROM executions e WHERE e.job_id=j.id ORDER BY queued_at DESC,id DESC LIMIT 1) latest,
    (SELECT count(*) FROM executions e WHERE e.job_id=j.id)::int execution_count FROM jobs j
    WHERE user_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 100`,
    [userId],
  );
  return result.rows.map(mapJob);
}
export async function getJobForUser(id: string, userId: string) {
  return (await listJobsForUser(userId)).find((j) => j.id === id) ?? null;
}
export async function createJob(userId: string, input: JobInput) {
  const id = crypto.randomUUID();
  await transaction(async (c) => {
    await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
    const count = await c.query(
      "SELECT count(*)::int n FROM jobs WHERE user_id=$1 AND deleted_at IS NULL",
      [userId],
    );
    if (count.rows[0].n >= 100)
      throw new AppError(409, "This workspace has reached its 100 job limit.");
    await c.query(
      `INSERT INTO jobs(id,user_id,name,description,type,endpoint,method,schedule,status,retry_limit,timeout_ms,next_run_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        userId,
        input.name,
        input.description,
        input.type,
        input.endpoint,
        input.method,
        input.schedule,
        input.status,
        input.retryLimit,
        input.timeoutMs,
        input.status === "active" ? nextScheduledAt(input.schedule) : null,
      ],
    );
  });
  return getJobForUser(id, userId);
}
export async function updateJob(
  id: string,
  userId: string,
  input: Partial<JobInput> & { version: number },
) {
  await transaction(async (c) => {
    const row = assertFound(
      (
        await c.query(
          "SELECT * FROM jobs WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE",
          [id, userId],
        )
      ).rows[0],
      "Job not found.",
    );
    if (row.version !== input.version)
      throw new AppError(
        409,
        "This job changed in another tab. Refresh and try again.",
      );
    const map = {
      name: "name",
      description: "description",
      type: "type",
      endpoint: "endpoint",
      method: "method",
      schedule: "schedule",
      status: "status",
      retryLimit: "retry_limit",
      timeoutMs: "timeout_ms",
    };
    const entries = Object.entries(input).filter(([k]) => k in map);
    const params: unknown[] = entries.map(([, v]) => v);
    const assignments = entries.map(
      ([k], i) => `${map[k as keyof typeof map]}=$${i + 1}`,
    );
    if (input.schedule !== undefined || input.status !== undefined) {
      params.push(
        (input.status ?? row.status) === "active"
          ? nextScheduledAt(input.schedule ?? row.schedule)
          : null,
      );
      assignments.push(`next_run_at=$${params.length}`);
    }
    params.push(id);
    await c.query(
      `UPDATE jobs SET ${assignments.length ? assignments.join(",") + "," : ""} version=version+1,updated_at=now() WHERE id=$${params.length}`,
      params,
    );
  });
  return getJobForUser(id, userId);
}
export async function archiveJob(id: string, userId: string, version: number) {
  const r = await query(
    `UPDATE jobs SET deleted_at=now(),status='paused',next_run_at=NULL,version=version+1,updated_at=now()
    WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL AND version=$3 RETURNING id`,
    [id, userId, version],
  );
  if (!r.rowCount)
    throw new AppError(
      409,
      "Job changed or no longer exists. Refresh and try again.",
    );
}
export async function listExecutionsForUser(
  userId: string,
  status = "all",
  offset = 0,
  jobId?: string,
) {
  const r = await query(
    `SELECT * FROM executions WHERE user_id=$1 AND ($2='all' OR status=$2)
    AND ($4::uuid IS NULL OR job_id=$4) ORDER BY queued_at DESC,id DESC LIMIT 50 OFFSET $3`,
    [userId, status, offset, jobId ?? null],
  );
  return r.rows.map(mapExecution);
}
export async function getExecutionForUser(
  id: string,
  userId: string,
): Promise<ExecutionDetail | null> {
  const r = (
    await query("SELECT * FROM executions WHERE id=$1 AND user_id=$2", [
      id,
      userId,
    ])
  ).rows[0];
  if (!r) return null;
  const [logs, attempts] = await Promise.all([
    query(
      "SELECT * FROM execution_logs WHERE execution_id=$1 ORDER BY id LIMIT 200",
      [id],
    ),
    query("SELECT * FROM attempts WHERE execution_id=$1 ORDER BY number", [id]),
  ]);
  return {
    ...mapExecution(r),
    logs: logs.rows.map((l) => ({
      id: Number(l.id),
      level: l.level,
      message: l.message,
      createdAt: iso(l.created_at)!,
    })),
    attempts: attempts.rows.map((a) => ({
      number: a.number,
      workerId: a.worker_id,
      startedAt: iso(a.started_at)!,
      finishedAt: iso(a.finished_at),
      outcome: a.outcome,
      errorCode: a.error_code,
      durationMs: a.duration_ms,
    })),
  };
}
export async function addLog(
  c: PoolClient,
  id: string,
  level: string,
  message: string,
) {
  await c.query(
    "INSERT INTO execution_logs(execution_id,level,message) VALUES($1,$2,$3)",
    [id, level, message],
  );
}
export function snapshotJob(j: Row) {
  return {
    name: j.name,
    endpoint: j.endpoint,
    method: j.method,
    type: j.type,
    timeoutMs: j.timeout_ms,
    retryLimit: j.retry_limit,
    version: j.version,
  };
}
export async function enqueue(
  userId: string,
  jobId: string,
  key: string,
  retryOfId?: string,
) {
  return transaction(async (c) => {
    // The key is scoped to the user, so it must also serialize requests for different jobs.
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${userId}:${key}`,
    ]);
    const j = assertFound(
      (
        await c.query(
          "SELECT * FROM jobs WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE",
          [jobId, userId],
        )
      ).rows[0],
      "Job not found.",
    );
    const old = (
      await c.query("SELECT * FROM run_requests WHERE user_id=$1 AND key=$2", [
        userId,
        key,
      ])
    ).rows[0];
    if (old) {
      if (old.job_id !== jobId)
        throw new AppError(
          409,
          "That idempotency key belongs to a different job.",
        );
      return { id: old.execution_id, created: false };
    }
    if (j.status === "paused")
      throw new AppError(409, "Activate this job before running it.");
    if (retryOfId) {
      const original = assertFound(
        (
          await c.query(
            "SELECT * FROM executions WHERE id=$1 AND user_id=$2 AND job_id=$3",
            [retryOfId, userId, jobId],
          )
        ).rows[0],
        "Execution not found.",
      );
      if (original.status !== "failed")
        throw new AppError(409, "Only failed runs can be retried.");
    }
    const active = (
      await c.query(
        "SELECT id FROM executions WHERE job_id=$1 AND status IN ('queued','running','retry_wait')",
        [jobId],
      )
    ).rows[0];
    const id = active?.id ?? crypto.randomUUID();
    if (!active) {
      await c.query(
        `INSERT INTO executions(id,job_id,user_id,snapshot,trigger,max_attempts,retry_of_id)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          jobId,
          userId,
          JSON.stringify(snapshotJob(j)),
          retryOfId ? "retry" : "manual",
          j.retry_limit + 1,
          retryOfId ?? null,
        ],
      );
      await addLog(
        c,
        id,
        "info",
        retryOfId
          ? "Manual retry queued using the current job configuration."
          : "Run accepted and saved in the queue.",
      );
    }
    await c.query(
      "INSERT INTO run_requests(user_id,key,job_id,execution_id) VALUES($1,$2,$3,$4)",
      [userId, key, jobId, id],
    );
    return { id, created: !active };
  });
}
export async function cancelExecution(id: string, userId: string) {
  return transaction(async (c) => {
    const e = assertFound(
      (
        await c.query(
          "SELECT * FROM executions WHERE id=$1 AND user_id=$2 FOR UPDATE",
          [id, userId],
        )
      ).rows[0],
      "Execution not found.",
    );
    if (!["queued", "retry_wait"].includes(e.status))
      throw new AppError(
        409,
        "Only queued or waiting runs can be cancelled. A running HTTP request may already have reached its target.",
      );
    await c.query(
      "UPDATE executions SET status='cancelled',finished_at=now() WHERE id=$1",
      [id],
    );
    await addLog(c, id, "warn", "Cancelled before the next attempt started.");
  });
}
export async function getHealth(userId: string): Promise<Health> {
  const [stats, counts, workers] = await Promise.all([
    query(
      `SELECT count(*)::int total, count(*) FILTER(WHERE status='succeeded')::int succeeded,
      count(*) FILTER(WHERE status='failed')::int failed,
      count(*) FILTER(WHERE status IN ('queued','retry_wait'))::int queued FROM executions WHERE user_id=$1`,
      [userId],
    ),
    query(
      `SELECT count(*)::int total, count(*) FILTER(WHERE status='active')::int active,
      count(*) FILTER(WHERE (SELECT status FROM executions WHERE job_id=jobs.id ORDER BY queued_at DESC,id DESC LIMIT 1)='failed')::int attention
      FROM jobs WHERE user_id=$1 AND deleted_at IS NULL`,
      [userId],
    ),
    query(
      `SELECT id,heartbeat_at,status,completed_count,heartbeat_at>now()-interval '45 seconds' alive FROM workers ORDER BY heartbeat_at DESC LIMIT 12`,
    ),
  ]);
  const list = workers.rows.map((w) => ({
    id: w.id,
    status: w.alive ? w.status : "offline",
    load: w.alive && w.status === "busy" ? 100 : 0,
    lastHeartbeat: iso(w.heartbeat_at)!,
    completed: w.completed_count,
  }));
  return {
    status: list.some((w) => w.status !== "offline")
      ? "operational"
      : "workers_offline",
    queueDepth: stats.rows[0].queued,
    totalExecutions: stats.rows[0].total,
    succeeded: stats.rows[0].succeeded,
    failed: stats.rows[0].failed,
    totalJobs: counts.rows[0].total,
    activeJobs: counts.rows[0].active,
    attentionCount: counts.rows[0].attention,
    workers: list,
  };
}
