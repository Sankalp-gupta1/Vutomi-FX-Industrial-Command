import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs/promises";
import { Dashboard, type WorkspaceSnapshot } from "../components/dashboard";
import { AuthScreen } from "../components/auth-screen";

// Static visual fixtures only. This writes no users, sessions or executions to the application.
async function render() {
  const css = await fs.readFile("app/globals.css", "utf8");
  const now = new Date().toISOString();
  const runs: WorkspaceSnapshot["runs"] = [
    "succeeded",
    "failed",
    "succeeded",
  ].map((status, i) => ({
    id: `fixture-run-${i}`,
    jobId: `fixture-job-${i}`,
    jobName: ["Service health check", "Payroll export", "New hire sync"][i],
    status: status as "succeeded" | "failed",
    trigger: i === 1 ? "schedule" : "manual",
    attempt: i === 1 ? 3 : 1,
    maxAttempts: 3,
    retryOfId: null,
    queuedAt: now,
    availableAt: now,
    startedAt: now,
    finishedAt: now,
    durationMs: 300 + i * 120,
    responseCode: i === 1 ? 503 : 200,
    errorCode: i === 1 ? "HTTP_503" : null,
    errorMessage: null,
    output: null,
    workerId: "preview-worker",
  }));
  const fixture: WorkspaceSnapshot = {
    user: {
      id: "fixture-user",
      name: "Preview account",
      email: "preview@example.test",
    },
    runs,
    jobs: runs.map((r, i) => ({
      id: r.jobId,
      name: r.jobName,
      description: "Static visual example",
      type: "http",
      endpoint: i === 1 ? "demo://failure" : "demo://success",
      method: "GET",
      schedule: i === 1 ? "Every hour" : "Manual only",
      status: "active",
      retryLimit: 2,
      timeoutMs: 5000,
      version: 1,
      lastRunAt: now,
      nextRunAt: null,
      createdAt: now,
      updatedAt: now,
      latestExecution: r,
      executionCount: 1,
    })),
    health: {
      status: "operational",
      queueDepth: 0,
      workers: [
        {
          id: "preview-worker",
          status: "idle",
          load: 0,
          lastHeartbeat: now,
          completed: 5,
        },
      ],
      activeJobs: 3,
      totalJobs: 3,
      totalExecutions: 3,
      succeeded: 2,
      failed: 1,
      attentionCount: 1,
    },
  };
  await fs.mkdir("artifacts", { recursive: true });
  for (const [name, content] of [
    ["workspace", <Dashboard initialData={fixture} />],
    ["signin", <AuthScreen onAuthenticated={() => undefined} />],
  ] as const) {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relay — static visual fixture</title><style>${css}</style></head><body>${renderToStaticMarkup(content)}</body></html>`;
    await fs.writeFile(`artifacts/${name}.html`, html);
  }
  await fs.writeFile(
    "artifacts/mobile.html",
    '<!doctype html><html><head><title>Relay mobile visual fixture</title></head><body style="margin:0;background:#050b16"><iframe title="Mobile workspace at 390 pixels" src="workspace.html" style="border:0;width:390px;height:1100px"></iframe></body></html>',
  );
  console.log(
    "Static visual fixtures written to artifacts/. These are not live application pages.",
  );
}
void render();
