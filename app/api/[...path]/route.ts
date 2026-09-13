import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "node:crypto";
import { z } from "zod";
import { query } from "@/lib/db";
import { AppError, assertFound } from "@/lib/errors";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  hashPassword,
  hashToken,
  rateLimit,
  requireUser,
  SESSION_COOKIE,
  setSessionCookie,
  verifyPassword,
} from "@/lib/auth";
import {
  credentialsSchema,
  registerSchema,
  jobSchema,
  jobPatchSchema,
  runSchema,
} from "@/lib/validation";
import {
  archiveJob,
  cancelExecution,
  createJob,
  enqueue,
  getExecutionForUser,
  getHealth,
  getJobForUser,
  listExecutionsForUser,
  listJobsForUser,
  updateJob,
} from "@/lib/repository";
import { validateTarget } from "@/lib/target";
import { logError } from "@/lib/logger";
import { openapi } from "@/lib/openapi";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const uuid = z.string().uuid();
const states = [
  "all",
  "queued",
  "running",
  "retry_wait",
  "succeeded",
  "failed",
  "cancelled",
];
async function body(request: Request) {
  if (!(request.headers.get("content-type") || "").includes("application/json"))
    throw new AppError(415, "Send an application/json request.");
  const reader = request.body?.getReader();
  if (!reader) return {};
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const r = await reader.read();
    if (r.done) break;
    size += r.value.length;
    if (size > 16384) {
      await reader.cancel();
      throw new AppError(413, "Request exceeds 16 KB.");
    }
    chunks.push(r.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new AppError(400, "The request body must be valid JSON.");
  }
}
function assertOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const expected = process.env.APP_URL
    ? new URL(process.env.APP_URL).origin
    : new URL(request.url).origin;
  if (
    (origin && origin !== expected) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new AppError(403, "Cross-site requests are not allowed.");
}
async function handle(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const requestId = crypto.randomUUID();
  try {
    const path = (await context.params).path;
    const route = path.join("/"),
      method = request.method;
    const url = new URL(request.url);
    if (method !== "GET") assertOrigin(request);
    if (route === "openapi" && method === "GET")
      return NextResponse.json(openapi);
    if (route === "health" && method === "GET") {
      await query("SELECT 1");
      return NextResponse.json({
        status: "ok",
        database: "connected",
        checkedAt: new Date().toISOString(),
      });
    }
    if (
      (route === "auth/login" || route === "auth/register") &&
      method === "POST"
    ) {
      const raw = await body(request);
      const email =
        typeof raw?.email === "string" ? raw.email.toLowerCase().trim() : "";
      const ip =
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        "local";
      await rateLimit(`auth-ip:${hashToken(ip)}`, 30);
      await rateLimit(`auth-email:${hashToken(email)}`, 10);
      let user;
      if (route === "auth/register") {
        const input = registerSchema.parse(raw);
        const passwordHash = await hashPassword(input.password);
        const r = await query(
          `INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO NOTHING RETURNING id,email,name`,
          [crypto.randomUUID(), input.email, input.name, passwordHash],
        );
        if (!r.rows[0])
          throw new AppError(409, "An account with this email already exists.");
        user = r.rows[0];
      } else {
        const input = credentialsSchema.parse(raw);
        const r = await query(
          "SELECT id,email,name,password_hash FROM users WHERE email=$1",
          [input.email],
        );
        user = r.rows[0];
        // Do the same expensive hash when an email is unknown.
        const dummy = "relay-dummy-salt:" + "0".repeat(128);
        if (
          !(await verifyPassword(
            input.password,
            user?.password_hash ?? dummy,
          )) ||
          !user
        )
          throw new AppError(401, "Email or password is incorrect.");
      }
      const session = await createSession(user.id);
      const response = NextResponse.json(
        { user: { id: user.id, email: user.email, name: user.name } },
        { status: route === "auth/register" ? 201 : 200 },
      );
      setSessionCookie(response, session.token, session.expiresAt);
      return response;
    }
    if (route === "auth/logout" && method === "POST") {
      await destroySession((await cookies()).get(SESSION_COOKIE)?.value);
      const r = NextResponse.json({ ok: true });
      clearSessionCookie(r);
      return r;
    }
    const user = await requireUser();
    if (method !== "GET") await rateLimit(`mutate:${user.id}`, 60);
    if (route === "me" && method === "GET") return NextResponse.json({ user });
    if (route === "system" && method === "GET")
      return NextResponse.json(await getHealth(user.id));
    if (route === "jobs") {
      if (method === "GET")
        return NextResponse.json({ jobs: await listJobsForUser(user.id) });
      if (method === "POST") {
        const input = jobSchema.parse(await body(request));
        try {
          validateTarget(input.endpoint);
        } catch (e) {
          throw new AppError(400, (e as Error).message);
        }
        return NextResponse.json(
          { job: await createJob(user.id, input) },
          { status: 201 },
        );
      }
    }
    if (path[0] === "jobs" && path[1]) {
      const id = uuid.parse(path[1]);
      if (path.length === 2) {
        if (method === "GET")
          return NextResponse.json({
            job: assertFound(
              await getJobForUser(id, user.id),
              "Job not found.",
            ),
          });
        if (method === "PATCH") {
          const input = jobPatchSchema.parse(await body(request));
          if (input.endpoint) {
            try {
              validateTarget(input.endpoint);
            } catch (e) {
              throw new AppError(400, (e as Error).message);
            }
          }
          return NextResponse.json({
            job: await updateJob(id, user.id, input),
          });
        }
        if (method === "DELETE") {
          const input = z
            .object({ version: z.number().int().positive() })
            .strict()
            .parse(await body(request));
          await archiveJob(id, user.id, input.version);
          return NextResponse.json({ ok: true });
        }
      }
      if (path[2] === "run" && path.length === 3 && method === "POST") {
        const input = runSchema.parse(await body(request));
        const key = z
          .string()
          .min(8)
          .max(120)
          .parse(
            input.idempotencyKey || request.headers.get("Idempotency-Key"),
          );
        const result = await enqueue(user.id, id, key);
        return NextResponse.json(
          {
            execution: await getExecutionForUser(result.id, user.id),
            deduplicated: !result.created,
          },
          { status: result.created ? 202 : 200 },
        );
      }
    }
    if (route === "executions" && method === "GET") {
      const status = url.searchParams.get("status") || "all";
      if (!states.includes(status))
        throw new AppError(400, "Unknown execution status.");
      const offset = z.coerce
        .number()
        .int()
        .min(0)
        .max(10000)
        .parse(url.searchParams.get("offset") || 0);
      const jobId = url.searchParams.get("jobId")
        ? uuid.parse(url.searchParams.get("jobId"))
        : undefined;
      const executions = await listExecutionsForUser(
        user.id,
        status,
        offset,
        jobId,
      );
      return NextResponse.json({
        executions,
        nextOffset: executions.length === 50 ? offset + 50 : null,
      });
    }
    if (path[0] === "executions" && path[1]) {
      const id = uuid.parse(path[1]);
      if (path.length === 2 && method === "GET")
        return NextResponse.json({
          execution: assertFound(
            await getExecutionForUser(id, user.id),
            "Execution not found.",
          ),
        });
      if (path.length === 3 && method === "POST") {
        if (path[2] === "retry") {
          const input = runSchema.parse(await body(request));
          const key = z
            .string()
            .min(8)
            .max(120)
            .parse(
              input.idempotencyKey || request.headers.get("Idempotency-Key"),
            );
          const original = assertFound(
            await getExecutionForUser(id, user.id),
            "Execution not found.",
          );
          const result = await enqueue(
            user.id,
            original.jobId,
            key,
            original.id,
          );
          return NextResponse.json(
            {
              execution: await getExecutionForUser(result.id, user.id),
              deduplicated: !result.created,
            },
            { status: result.created ? 202 : 200 },
          );
        }
        if (path[2] === "cancel") {
          await cancelExecution(id, user.id);
          return NextResponse.json({ ok: true });
        }
      }
    }
    throw new AppError(404, "API endpoint not found.");
  } catch (error) {
    if (error instanceof AppError)
      return NextResponse.json(
        { error: error.message, requestId },
        { status: error.status },
      );
    if (error instanceof z.ZodError)
      return NextResponse.json(
        { error: error.issues[0]?.message || "Invalid request.", requestId },
        { status: 400 },
      );
    logError("api.error", error, { requestId });
    return NextResponse.json(
      {
        error: "The service is temporarily unavailable. Please try again.",
        requestId,
      },
      { status: 503 },
    );
  }
}
export { handle as GET, handle as POST, handle as PATCH, handle as DELETE };
