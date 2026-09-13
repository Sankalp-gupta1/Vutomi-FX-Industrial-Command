const json = (schema: object) => ({ "application/json": { schema } });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const error = { description: "Request rejected", content: json(ref("Error")) };
const responses = (schema: object, code = "200") => ({
  [code]: {
    description: code === "202" ? "Queued for a worker" : "Success",
    content: json(schema),
  },
  400: error,
  401: error,
  403: error,
  404: error,
  409: error,
  429: error,
  503: error,
});
const body = (schema: object) => ({ required: true, content: json(schema) });
const id = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
};
const runKey = {
  type: "object",
  required: ["idempotencyKey"],
  properties: {
    idempotencyKey: { type: "string", minLength: 8, maxLength: 120 },
  },
};
const jobProperties = {
  name: { type: "string", minLength: 2, maxLength: 80 },
  description: { type: "string", maxLength: 240 },
  type: { type: "string", enum: ["http", "webhook"] },
  endpoint: {
    type: "string",
    description: "Demo target or allowlisted HTTPS URL",
  },
  method: { type: "string", enum: ["GET", "POST"] },
  schedule: {
    type: "string",
    enum: ["Manual only", "Every 15 minutes", "Every hour", "Daily at 02:00"],
  },
  status: { type: "string", enum: ["active", "paused"] },
  retryLimit: { type: "integer", minimum: 0, maximum: 3 },
  timeoutMs: { type: "integer", minimum: 1000, maximum: 15000 },
};
const login = {
  type: "object",
  required: ["email", "password"],
  properties: {
    email: { type: "string", format: "email", maxLength: 120 },
    password: { type: "string", minLength: 10, maxLength: 128 },
  },
};
export const openapi = {
  openapi: "3.0.3",
  info: {
    title: "Relay API",
    version: "1.0.0",
    description:
      "Jobs and runs belong to the signed-in user. Mutations require a same-origin request and JSON. Dates use ISO 8601 UTC. The worker is a separate process; HTTP 202 means the run is saved, not completed.",
  },
  servers: [{ url: "/api" }],
  security: [{ session: [] }],
  paths: {
    "/auth/register": {
      post: {
        summary: "Create an account and session",
        security: [],
        requestBody: body({
          ...login,
          required: ["name", "email", "password"],
          properties: {
            ...login.properties,
            name: { type: "string", minLength: 2, maxLength: 60 },
          },
        }),
        responses: responses(ref("UserResponse"), "201"),
      },
    },
    "/auth/login": {
      post: {
        summary: "Sign in",
        security: [],
        requestBody: body(login),
        responses: responses(ref("UserResponse")),
      },
    },
    "/auth/logout": {
      post: {
        summary: "Revoke the current session",
        responses: responses(ref("Ok")),
      },
    },
    "/me": {
      get: {
        summary: "Read the signed-in user",
        responses: responses(ref("UserResponse")),
      },
    },
    "/jobs": {
      get: {
        summary: "List up to 100 non-archived jobs",
        responses: responses({
          type: "object",
          properties: { jobs: { type: "array", items: ref("Job") } },
        }),
      },
      post: {
        summary: "Create a job",
        requestBody: body({
          type: "object",
          required: ["name", "endpoint"],
          properties: jobProperties,
          additionalProperties: false,
        }),
        responses: responses(
          { type: "object", properties: { job: ref("Job") } },
          "201",
        ),
      },
    },
    "/jobs/{id}": {
      parameters: [id],
      get: {
        summary: "Read a job",
        responses: responses({
          type: "object",
          properties: { job: ref("Job") },
        }),
      },
      patch: {
        summary: "Update a job with optimistic concurrency",
        requestBody: body({
          type: "object",
          required: ["version"],
          properties: {
            ...jobProperties,
            version: { type: "integer", minimum: 1 },
          },
          additionalProperties: false,
        }),
        responses: responses({
          type: "object",
          properties: { job: ref("Job") },
        }),
      },
      delete: {
        summary: "Archive a job; preserve history and accepted runs",
        requestBody: body({
          type: "object",
          required: ["version"],
          properties: { version: { type: "integer", minimum: 1 } },
        }),
        responses: responses(ref("Ok")),
      },
    },
    "/jobs/{id}/run": {
      parameters: [id],
      post: {
        summary: "Queue one run; coalesce overlapping clicks",
        description:
          "Reusing a key returns the same run. Keys are scoped to the user. A new key while the job is active maps to the existing active run.",
        requestBody: body(runKey),
        responses: responses(ref("RunResponse"), "202"),
      },
    },
    "/executions": {
      get: {
        summary: "List 50 runs per page, newest first",
        parameters: [
          {
            name: "status",
            in: "query",
            schema: {
              type: "string",
              enum: [
                "all",
                "queued",
                "running",
                "retry_wait",
                "succeeded",
                "failed",
                "cancelled",
              ],
            },
          },
          {
            name: "offset",
            in: "query",
            schema: { type: "integer", minimum: 0, maximum: 10000 },
          },
          {
            name: "jobId",
            in: "query",
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: responses({
          type: "object",
          properties: {
            executions: { type: "array", items: ref("Execution") },
            nextOffset: { type: "integer", nullable: true },
          },
        }),
      },
    },
    "/executions/{id}": {
      parameters: [id],
      get: {
        summary: "Read one run with attempts and logs",
        responses: responses(ref("RunResponse")),
      },
    },
    "/executions/{id}/retry": {
      parameters: [id],
      post: {
        summary: "Retry a failed run using current job settings",
        requestBody: body(runKey),
        responses: responses(ref("RunResponse"), "202"),
      },
    },
    "/executions/{id}/cancel": {
      parameters: [id],
      post: {
        summary: "Cancel queued or retry-waiting work",
        responses: responses(ref("Ok")),
      },
    },
    "/system": {
      get: {
        summary: "Read workspace statistics and recent worker heartbeats",
        responses: responses({ type: "object" }),
      },
    },
    "/health": {
      get: {
        summary: "Public database liveness check",
        security: [],
        responses: responses({
          type: "object",
          properties: {
            status: { type: "string" },
            database: { type: "string" },
            checkedAt: { type: "string", format: "date-time" },
          },
        }),
      },
    },
  },
  components: {
    securitySchemes: {
      session: { type: "apiKey", in: "cookie", name: "relay_session" },
    },
    schemas: {
      Error: {
        type: "object",
        properties: {
          error: { type: "string" },
          requestId: { type: "string" },
        },
      },
      Ok: { type: "object", properties: { ok: { type: "boolean" } } },
      UserResponse: {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              email: { type: "string" },
              name: { type: "string" },
            },
          },
        },
      },
      Job: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          ...jobProperties,
          version: { type: "integer" },
          nextRunAt: { type: "string", format: "date-time", nullable: true },
          latestExecution: ref("Execution"),
        },
      },
      Execution: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          jobId: { type: "string", format: "uuid" },
          jobName: { type: "string" },
          status: {
            type: "string",
            enum: [
              "queued",
              "running",
              "retry_wait",
              "succeeded",
              "failed",
              "cancelled",
            ],
          },
          attempt: { type: "integer" },
          maxAttempts: { type: "integer" },
          errorCode: { type: "string", nullable: true },
          errorMessage: { type: "string", nullable: true },
          workerId: { type: "string", nullable: true },
          logs: { type: "array", items: { type: "object" } },
          attempts: { type: "array", items: { type: "object" } },
        },
      },
      RunResponse: {
        type: "object",
        properties: {
          execution: ref("Execution"),
          deduplicated: { type: "boolean" },
        },
      },
    },
  },
};
