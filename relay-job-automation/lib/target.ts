import https from "node:https";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { setTimeout as delay } from "node:timers/promises";
import { demoTargets } from "./validation";
export type TargetConfig = {
  name: string;
  endpoint: string;
  method: string;
  timeoutMs: number;
  retryLimit: number;
  version: number;
};
export type TargetResult = {
  ok: boolean;
  retryable: boolean;
  responseCode?: number;
  output?: string;
  errorCode?: string;
  errorMessage?: string;
};
export function isPublicAddress(address: string) {
  try {
    const ip = ipaddr.process(address);
    return ip.range() === "unicast";
  } catch {
    return false;
  }
}
export function validateTarget(endpoint: string) {
  if ((demoTargets as readonly string[]).includes(endpoint)) return;
  const url = new URL(endpoint);
  const allowed = (process.env.JOB_ALLOWED_HOSTS || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !allowed.includes(url.hostname.toLowerCase())
  ) {
    throw new Error(
      "For external HTTP jobs, the server owner must add this HTTPS hostname to JOB_ALLOWED_HOSTS. Demo targets work immediately.",
    );
  }
}
async function externalTarget(
  config: TargetConfig,
  id: string,
  signal: AbortSignal,
): Promise<TargetResult> {
  try {
    validateTarget(config.endpoint);
  } catch {
    return {
      ok: false,
      retryable: false,
      errorCode: "BLOCKED_TARGET",
      errorMessage:
        "This target is not permitted by the worker hostname allowlist.",
    };
  }
  const url = new URL(config.endpoint);
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
    return {
      ok: false,
      retryable: false,
      errorCode: "BLOCKED_TARGET",
      errorMessage: "The target resolves to a private or reserved address.",
    };
  signal.throwIfAborted();
  const pinned = addresses[0];
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: config.method,
        signal,
        family: pinned.family,
        lookup: (_hostname, _options, cb) => {
          cb(null, pinned.address, pinned.family);
        },
        headers: {
          "User-Agent": "Relay/1.0",
          Accept: "application/json, text/plain",
          "Idempotency-Key": id,
          ...(config.method === "POST"
            ? { "Content-Type": "application/json" }
            : {}),
        },
      },
      (response) => {
        const code = response.statusCode ?? 0;
        let size = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 65536) {
            request.destroy();
            resolve({
              ok: false,
              retryable: false,
              errorCode: "OUTPUT_TOO_LARGE",
              errorMessage: "Target response exceeded 64 KB.",
            });
          } else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            ok: code >= 200 && code < 300,
            retryable: code === 429 || code >= 500,
            responseCode: code,
            output: Buffer.concat(chunks).toString("utf8").slice(0, 2000),
            ...(code >= 200 && code < 300
              ? {}
              : {
                  errorCode: `HTTP_${code}`,
                  errorMessage: `Target returned HTTP ${code}.${code >= 300 && code < 400 ? " Redirects are not followed." : ""}`,
                }),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(
      config.method === "POST"
        ? JSON.stringify({ executionId: id, source: "relay" })
        : undefined,
    );
  });
}
export async function runTarget(
  config: TargetConfig,
  executionId: string,
  attempt: number,
  leaseSignal?: AbortSignal,
): Promise<TargetResult> {
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const signal = leaseSignal
    ? AbortSignal.any([timeout, leaseSignal])
    : timeout;
  const run = async (): Promise<TargetResult> => {
    const endpoint = config.endpoint;
    if (endpoint.startsWith("demo://")) {
      await delay(
        endpoint === "demo://timeout"
          ? config.timeoutMs + 500
          : endpoint === "demo://slow"
            ? 1800
            : 300,
        undefined,
        { signal },
      );
      if (
        endpoint === "demo://failure" ||
        (endpoint === "demo://flaky" && attempt < 3)
      )
        return {
          ok: false,
          retryable: true,
          responseCode: 503,
          errorCode: "UPSTREAM_UNAVAILABLE",
          errorMessage:
            "Demo service returned 503. This is an intentional failure for testing retries.",
        };
      return {
        ok: true,
        retryable: false,
        responseCode: 200,
        output: JSON.stringify(
          { message: "Demo target completed", executionId, attempt },
          null,
          2,
        ),
      };
    }
    return externalTarget(config, executionId, signal);
  };
  let abort: () => void = () => undefined;
  try {
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    return await Promise.race([run(), aborted]);
  } catch {
    if (leaseSignal?.aborted)
      return {
        ok: false,
        retryable: true,
        errorCode: "LEASE_LOST",
        errorMessage:
          "Worker lost ownership before it could confirm the result.",
      };
    if (timeout.aborted)
      return {
        ok: false,
        retryable: true,
        errorCode: "TIMEOUT",
        errorMessage: `No complete response within ${config.timeoutMs}ms. The target may already have received the request.`,
      };
    return {
      ok: false,
      retryable: true,
      errorCode: "NETWORK_ERROR",
      errorMessage: "The HTTPS request could not be completed.",
    };
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
