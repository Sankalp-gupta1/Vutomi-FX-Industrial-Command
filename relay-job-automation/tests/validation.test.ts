import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../lib/auth";
import { jobSchema, nextScheduledAt, registerSchema } from "../lib/validation";
import { isPublicAddress, runTarget, validateTarget } from "../lib/target";
import { retryDelayMs } from "../lib/execution";
describe("untrusted input and execution boundaries", () => {
  it.each([
    "http://example.com",
    "https://user:pass@example.com",
    "https://example.com:8443",
    "file:///etc/passwd",
    "demo://unknown",
  ])("rejects unsafe or unknown URL %s", (endpoint) => {
    expect(jobSchema.safeParse({ name: "Test job", endpoint }).success).toBe(
      false,
    );
  });
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.2",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "224.0.0.1",
  ])("blocks non-public address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it("requires an exact allowlisted HTTPS hostname", () => {
    const old = process.env.JOB_ALLOWED_HOSTS;
    process.env.JOB_ALLOWED_HOSTS = "example.com";
    try {
      expect(() => validateTarget("https://example.com/ping")).not.toThrow();
      expect(() => validateTarget("https://example.com.evil.test")).toThrow();
      expect(() => validateTarget("https://127.0.0.1")).toThrow();
    } finally {
      if (old !== undefined) process.env.JOB_ALLOWED_HOSTS = old;
      else delete process.env.JOB_ALLOWED_HOSTS;
    }
  });
  it("rejects unknown fields, excessive retries and short passwords", () => {
    expect(
      jobSchema.safeParse({
        name: "Test",
        endpoint: "demo://success",
        admin: true,
      }).success,
    ).toBe(false);
    expect(
      jobSchema.safeParse({
        name: "Test",
        endpoint: "demo://success",
        retryLimit: 99,
      }).success,
    ).toBe(false);
    expect(
      registerSchema.safeParse({
        name: "Test",
        email: "test@example.test",
        password: "short",
      }).success,
    ).toBe(false);
  });
  it("salts passwords and safely rejects wrong or malformed hashes", async () => {
    const a = await hashPassword("test-password-123"),
      b = await hashPassword("test-password-123");
    expect(a).not.toBe(b);
    expect(await verifyPassword("test-password-123", a)).toBe(true);
    expect(await verifyPassword("wrong-password-123", a)).toBe(false);
    expect(await verifyPassword("anything", "broken")).toBe(false);
  });
  it("computes daily schedules in UTC and never repeats the current slot", () => {
    expect(
      nextScheduledAt(
        "Daily at 02:00",
        new Date("2026-09-13T02:00:00Z"),
      )?.toISOString(),
    ).toBe("2026-09-14T02:00:00.000Z");
    expect(
      nextScheduledAt(
        "Every 15 minutes",
        new Date("2026-09-13T02:00:00Z"),
      )?.toISOString(),
    ).toBe("2026-09-13T02:15:00.000Z");
    expect(nextScheduledAt("Manual only")).toBeNull();
    expect(retryDelayMs(2, 0)).toBe(2000);
  });
  it("enforces a real timeout and reports an uncertain external outcome", async () => {
    const result = await runTarget(
      {
        name: "Timeout",
        endpoint: "demo://timeout",
        method: "GET",
        timeoutMs: 40,
        retryLimit: 0,
        version: 1,
      },
      "test-run",
      1,
    );
    expect(result.errorCode).toBe("TIMEOUT");
    expect(result.errorMessage).toContain("may already have received");
  });
  it("aborts work after a lost lease", async () => {
    const lease = new AbortController();
    lease.abort();
    const result = await runTarget(
      {
        name: "Lost lease",
        endpoint: "demo://slow",
        method: "GET",
        timeoutMs: 5000,
        retryLimit: 1,
        version: 1,
      },
      "lost-run",
      1,
      lease.signal,
    );
    expect(result.errorCode).toBe("LEASE_LOST");
  });
});
