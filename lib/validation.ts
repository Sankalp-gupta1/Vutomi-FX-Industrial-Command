import { z } from "zod";
export const schedules = [
  "Manual only",
  "Every 15 minutes",
  "Every hour",
  "Daily at 02:00",
] as const;
export const demoTargets = [
  "demo://success",
  "demo://failure",
  "demo://slow",
  "demo://timeout",
  "demo://flaky",
] as const;
export const credentialsSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email("Enter a valid email address")
      .max(120)
      .transform((x) => x.toLowerCase()),
    password: z.string().min(10, "Use at least 10 characters").max(128),
  })
  .strict();
export const registerSchema = credentialsSchema.extend({
  name: z.string().trim().min(2).max(60),
});
export const jobSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(240).default(""),
    type: z.enum(["http", "webhook"]).default("http"),
    endpoint: z
      .string()
      .trim()
      .max(500)
      .refine((value) => {
        if ((demoTargets as readonly string[]).includes(value)) return true;
        try {
          const u = new URL(value);
          return (
            u.protocol === "https:" &&
            !u.username &&
            !u.password &&
            (!u.port || u.port === "443")
          );
        } catch {
          return false;
        }
      }, "Choose a demo target or an HTTPS URL on port 443 without credentials."),
    method: z.enum(["GET", "POST"]).default("GET"),
    schedule: z.enum(schedules).default("Manual only"),
    status: z.enum(["active", "paused"]).default("active"),
    retryLimit: z.number().int().min(0).max(3).default(2),
    timeoutMs: z.number().int().min(1000).max(15000).default(5000),
  })
  .strict();
export const jobPatchSchema = jobSchema
  .partial()
  .extend({ version: z.number().int().positive() })
  .strict();
export const runSchema = z
  .object({ idempotencyKey: z.string().min(8).max(120).optional() })
  .strict();
export type JobInput = z.infer<typeof jobSchema>;
export function nextScheduledAt(
  schedule: string,
  from = new Date(),
): Date | null {
  if (schedule === "Every 15 minutes") return new Date(from.getTime() + 900000);
  if (schedule === "Every hour") return new Date(from.getTime() + 3600000);
  if (schedule === "Daily at 02:00") {
    const date = new Date(from);
    date.setUTCHours(2, 0, 0, 0);
    if (date <= from) date.setUTCDate(date.getUTCDate() + 1);
    return date;
  }
  return null;
}
