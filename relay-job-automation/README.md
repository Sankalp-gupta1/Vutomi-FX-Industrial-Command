# Relay

A small workspace for jobs you need to run again. Create an HTTP job, run it now or on a schedule, and follow each attempt when something goes wrong.

Built for the Enrichly HR Full Stack Developer Intern assignment. The frontend and API use Next.js, React and TypeScript. PostgreSQL stores accounts, jobs, the queue and execution history. A separate Node.js worker executes the jobs.

## Try a complete flow

1. Create an account; each account starts with an empty workspace.
2. Create a job using **Successful request**, then select **Run now**. The request is saved first; a worker updates its status in the background.
3. Create a **Recovering service** job with two retries. Its first two attempts return an intentional 503; the third succeeds. Open the execution to inspect all attempts and logs.
4. Try **Failing service** or **Timeout** to see a terminal failure. Edit the target, then retry the failed run. The original history stays intact.
5. Pause a job, edit it, or archive it. Archiving keeps its execution history. Open **Workers** to see actual heartbeats.

The example targets are explicitly simulated services. They execute inside the real worker, use the real queue, and save real results. No account, history, worker count or success metric is pre-populated.

## Run locally with Docker

Requires Docker with Compose. From this directory:

```sh
docker compose up --build --scale worker=2
```

Open http://localhost:3000. Compose starts PostgreSQL 16, applies migrations, starts the web app and runs two workers. Database data survives restarts in a named volume. The password in Compose is for local development only. `docker compose down` stops the services and keeps the data.

## Run locally with Node

Requires Node 22.10+ and PostgreSQL 16+. PostgreSQL 16 is the reference database used by CI.

```sh
npm ci
cp .env.example .env
docker compose up -d db
npm run db:migrate
npm run dev
```

In another terminal:

```sh
npm run worker
```

Start another worker in a third terminal to exercise multiple consumers. Worker IDs are generated automatically; do not assign the same `WORKER_ID` to two processes. Worker and migration commands load `.env`; Next.js loads it for the web app. Restart each process after environment changes.

**No Docker available?** Run `npm run dev:db` in its own terminal, set `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5434/postgres` in `.env`, then run the migration, web and worker commands above. This optional PGlite server persists to `data/dev-postgres`. It is a development convenience with a single PostgreSQL backend and is not a production database or proof of concurrent row locking.

## Configuration

| Variable            | Used by                 | Purpose                                                                                                                          |
| ------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`      | API, worker, migrations | PostgreSQL connection string. Use the provider's TLS configuration in production.                                                |
| `APP_URL`           | API                     | Exact browser origin, e.g. `https://your-app.vercel.app`. Used to reject cross-site mutations.                                   |
| `JOB_ALLOWED_HOSTS` | API and worker          | Comma-separated exact hostnames for external HTTPS targets. Empty allows only demo targets. Set the same value in both services. |
| `WORKER_ID`         | Worker                  | Optional unique process label. Omit to generate one.                                                                             |
| `TEST_DATABASE_URL` | Tests only              | Enables native PostgreSQL tests in an isolated temporary schema. Test role needs schema create/drop rights.                      |

Never commit `.env`, connection strings from a hosting provider, or session tokens. The web build does not need a database connection; the running API does.

## Tests and quality checks

```sh
npm run format:check
npm run typecheck
npm test
npm run build
npm run test:smoke
```

The default suite runs SQL against an isolated in-memory PGlite database and checks ownership, idempotency, snapshots, retry budgets, crash recovery, stale lease rejection, scheduling, cancellation, session expiry, input validation and target restrictions. Five tests explicitly require native PostgreSQL and are skipped without `TEST_DATABASE_URL`.

To run those tests against a real database:

```sh
TEST_DATABASE_URL=postgresql://relay:relay_local_only@127.0.0.1:5432/relay npm test
```

Tests create a random schema and remove only that schema afterward. GitHub Actions provisions PostgreSQL 16 and runs the entire suite, including simultaneous claims, `SKIP LOCKED`, overlapping submissions, concurrent edits and competing schedulers. The smoke script starts the built API and two worker processes, then checks the actual HTTP flow. It uses a separate isolated database and does not use saved application accounts. See [VERIFICATION.md](VERIFICATION.md) for the checks actually completed in this workspace.

## API

Human-readable endpoint reference: `/api/docs`. OpenAPI 3 JSON: `/api/openapi`. Database liveness: `/api/health`. The authenticated `/api/system` endpoint also reports worker availability.

All account data endpoints require the `relay_session` cookie. Run and retry requests require an `idempotencyKey` (or `Idempotency-Key` header). Reuse the key if a response is lost. A new execution returns **202 Accepted**, with its saved ID and status. Acceptance is not completion. Poll `/api/executions/{id}` to follow progress; the UI polls every two seconds while visible.

Job updates and archive requests require the current `version`. Conflicting edits return 409. Validation errors return 400; unauthorized requests 401; unknown or other users' resources 404; rate limits 429; database failures 503 with a request ID.

## Deploy: Vercel + PostgreSQL + a worker

This application needs **three running pieces**. Deploying the Next.js app alone leaves runs queued until a worker connects.

1. Provision a PostgreSQL database with a provider reachable from Vercel and the worker. Use a direct connection for migrations and the worker; a provider-supported pooled connection can be used by the API. Keep credentials in hosting environment settings.
2. Set `DATABASE_URL` in a trusted local shell or migration job and run `npm ci` followed by `npm run db:migrate`. Migrations are transactional, locked against concurrent application, and checksum checked. Run this before deploying code that needs a new migration.
3. Import this repository into Vercel as a Next.js project. Set `DATABASE_URL`, `APP_URL` to its public production origin, and optionally `JOB_ALLOWED_HOSTS`. Deploy from the repository root. `vercel.json` specifies the build; no cron trigger is needed.
4. Deploy the Docker **worker** target to a host that supports an always-running process (a container host or VM). Configure `DATABASE_URL` and the same `JOB_ALLOWED_HOSTS`, use a restart policy, and start `npm run worker`. Start two instances to demonstrate concurrent consumption. The worker needs no public inbound port.
5. Sign up on the production URL, run a success and a failure job, and confirm worker heartbeats, persisted logs and retry behavior. Verify the live URL can be opened without a Vercel team login before submitting it. Keep production and preview databases separate.

Example build commands for a container host:

```sh
docker build --target worker -t relay-worker .
docker run --env-file .env --restart unless-stopped relay-worker
```

Use a production `.env` containing the remote database connection. That connection must be reachable inside the container; a host-local `127.0.0.1` connection is not a remote database.

Deployment state and remaining account setup are recorded in [VERIFICATION.md](VERIFICATION.md). [ENGINEERING.md](ENGINEERING.md) explains the queue design and its limits.
