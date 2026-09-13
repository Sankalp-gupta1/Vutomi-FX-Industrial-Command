import crypto from "node:crypto";
import { promisify } from "node:util";
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import { query } from "./db";
import { AppError } from "./errors";
const scrypt = promisify(crypto.scrypt);
export const SESSION_COOKIE = "relay_session";
export type CurrentUser = { id: string; email: string; name: string };
export function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
export async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected || !/^[a-f0-9]{128}$/.test(expected)) return false;
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  return crypto.timingSafeEqual(actual, Buffer.from(expected, "hex"));
}
export async function createSession(userId: string) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 7 * 86400000);
  await query(
    "INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ($1,$2,$3)",
    [hashToken(token), userId, expiresAt],
  );
  return { token, expiresAt };
}
export async function userForToken(
  token: string | undefined,
): Promise<CurrentUser | null> {
  if (!token) return null;
  const result = await query<CurrentUser>(
    `SELECT u.id,u.email,u.name FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=$1 AND s.expires_at>now()`,
    [hashToken(token)],
  );
  return result.rows[0] ?? null;
}
export async function getCurrentUser() {
  return userForToken((await cookies()).get(SESSION_COOKIE)?.value);
}
export async function requireUser() {
  const u = await getCurrentUser();
  if (!u) throw new AppError(401, "Sign in to continue.");
  return u;
}
export async function destroySession(token: string | undefined) {
  if (token)
    await query("DELETE FROM sessions WHERE token_hash=$1", [hashToken(token)]);
}
export function setSessionCookie(
  response: NextResponse,
  token: string,
  expiresAt: Date,
) {
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
    path: "/",
  });
}
export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
    path: "/",
  });
}
export async function rateLimit(key: string, limit = 30, windowMs = 60000) {
  const bucket = Math.floor(Date.now() / windowMs);
  const result = await query<{ hits: number }>(
    `INSERT INTO rate_limits(key,bucket) VALUES($1,$2)
    ON CONFLICT(key,bucket) DO UPDATE SET hits=rate_limits.hits+1 RETURNING hits`,
    [key, bucket],
  );
  if (result.rows[0].hits > limit)
    throw new AppError(429, "Too many requests. Please try again in a minute.");
}
