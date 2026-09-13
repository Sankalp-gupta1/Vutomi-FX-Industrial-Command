export type ExecutionStatus =
  "queued" | "running" | "retry_wait" | "succeeded" | "failed" | "cancelled";
export type ExecutionTrigger = "manual" | "retry" | "schedule";
export type JobStatus = "active" | "paused";
export type Job = {
  id: string;
  name: string;
  description: string;
  type: string;
  endpoint: string;
  method: string;
  schedule: string;
  status: JobStatus;
  retryLimit: number;
  timeoutMs: number;
  version: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  latestExecution: ExecutionSummary | null;
  executionCount: number;
};
export type ExecutionSummary = {
  id: string;
  jobId: string;
  jobName: string;
  status: ExecutionStatus;
  trigger: ExecutionTrigger;
  attempt: number;
  maxAttempts: number;
  retryOfId: string | null;
  queuedAt: string;
  availableAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  responseCode: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  output: string | null;
  workerId: string | null;
};
export type ExecutionDetail = ExecutionSummary & {
  logs: Array<{
    id: number;
    level: string;
    message: string;
    createdAt: string;
  }>;
  attempts: Array<{
    number: number;
    workerId: string;
    startedAt: string;
    finishedAt: string | null;
    outcome: string | null;
    errorCode: string | null;
    durationMs: number | null;
  }>;
};
export type Health = {
  status: string;
  queueDepth: number;
  workers: Array<{
    id: string;
    status: string;
    load: number;
    lastHeartbeat: string;
    completed: number;
  }>;
  activeJobs: number;
  totalJobs: number;
  totalExecutions: number;
  succeeded: number;
  failed: number;
  attentionCount: number;
};
