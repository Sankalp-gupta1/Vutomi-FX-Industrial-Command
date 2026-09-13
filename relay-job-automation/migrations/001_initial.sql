CREATE TABLE users (
  id UUID PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE TABLE jobs (
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'http',
  endpoint TEXT NOT NULL, method TEXT NOT NULL DEFAULT 'GET',
  schedule TEXT NOT NULL DEFAULT 'Manual only', status TEXT NOT NULL DEFAULT 'active',
  retry_limit INT NOT NULL DEFAULT 2 CHECK (retry_limit BETWEEN 0 AND 3),
  timeout_ms INT NOT NULL DEFAULT 5000 CHECK (timeout_ms BETWEEN 1000 AND 15000),
  version INT NOT NULL DEFAULT 1, last_run_at TIMESTAMPTZ, next_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ, UNIQUE(id,user_id), CHECK(status IN ('active','paused'))
);
CREATE INDEX jobs_due_idx ON jobs(next_run_at) WHERE status='active' AND deleted_at IS NULL;
CREATE INDEX jobs_owner_idx ON jobs(user_id,updated_at DESC);
CREATE TABLE executions (
  id UUID PRIMARY KEY, job_id UUID NOT NULL, user_id UUID NOT NULL REFERENCES users(id),
  snapshot JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'queued', trigger TEXT NOT NULL DEFAULT 'manual',
  attempt INT NOT NULL DEFAULT 0 CHECK(attempt >= 0), max_attempts INT NOT NULL CHECK(max_attempts BETWEEN 1 AND 4),
  retry_of_id UUID REFERENCES executions(id), queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(), started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
  duration_ms INT, response_code INT, error_code TEXT, error_message TEXT, output TEXT, worker_id TEXT,
  lease_token UUID, lease_until TIMESTAMPTZ,
  FOREIGN KEY(job_id,user_id) REFERENCES jobs(id,user_id),
  CHECK(status IN ('queued','running','retry_wait','succeeded','failed','cancelled')),
  CHECK(trigger IN ('manual','retry','schedule'))
);
CREATE UNIQUE INDEX executions_one_active_job_idx ON executions(job_id) WHERE status IN ('queued','running','retry_wait');
CREATE INDEX executions_claim_idx ON executions(available_at,queued_at) WHERE status IN ('queued','retry_wait');
CREATE INDEX executions_lease_idx ON executions(lease_until) WHERE status='running';
CREATE INDEX executions_owner_idx ON executions(user_id,queued_at DESC);
CREATE INDEX executions_job_idx ON executions(job_id,queued_at DESC);
CREATE TABLE run_requests (
  user_id UUID NOT NULL REFERENCES users(id), key TEXT NOT NULL, job_id UUID NOT NULL REFERENCES jobs(id),
  execution_id UUID NOT NULL REFERENCES executions(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,key)
);
CREATE TABLE attempts (
  execution_id UUID NOT NULL REFERENCES executions(id), number INT NOT NULL, lease_token UUID NOT NULL,
  worker_id TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
  outcome TEXT, duration_ms INT, response_code INT, error_code TEXT, error_message TEXT,
  PRIMARY KEY(execution_id,number)
);
CREATE TABLE execution_logs (
  id BIGSERIAL PRIMARY KEY, execution_id UUID NOT NULL REFERENCES executions(id),
  level TEXT NOT NULL, message TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX execution_logs_idx ON execution_logs(execution_id,id);
CREATE TABLE workers (
  id TEXT PRIMARY KEY, heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(), status TEXT NOT NULL DEFAULT 'idle',
  execution_id UUID REFERENCES executions(id), completed_count INT NOT NULL DEFAULT 0
);
CREATE TABLE rate_limits (
  key TEXT NOT NULL, bucket BIGINT NOT NULL, hits INT NOT NULL DEFAULT 1,
  PRIMARY KEY(key,bucket)
);
