import "server-only";
import { createHash, randomBytes } from "node:crypto";

/**
 * The sign-in session token: 32 random bytes (256 bits) in the cookie.
 * The database keeps only its SHA-256 hash, so a copy of the database
 * can't be turned back into a working cookie.
 */

/** How long a sign-in lasts before the designer must sign in again. */
export const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 bytes in base64url

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isWellFormedSessionToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
