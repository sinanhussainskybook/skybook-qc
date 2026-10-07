import "server-only";

/**
 * Server settings for Skybook AI QC, read from environment variables.
 *
 * `import "server-only"` makes the build fail if this file is ever pulled
 * into browser code, so settings (and later, secrets) stay on the server.
 */

/** Upload limit used when MAX_UPLOAD_MB is not set or not usable. */
export const DEFAULT_UPLOAD_LIMIT_MB = 25;

/** Hard ceiling, so a typo like "25000" can't allow 25 GB uploads. */
export const MAX_ALLOWED_UPLOAD_LIMIT_MB = 500;

/**
 * Turn a text setting into a whole number of megabytes.
 *
 * Returns `null` for anything that isn't a whole number from 1 up to the
 * ceiling — blank, words, decimals, zero, negatives, or too large. The
 * caller then uses the default instead of silently doing something odd.
 */
export function parseMegabytes(raw: string | undefined): number | null {
  const text = raw?.trim();
  if (!text || !/^\d+$/.test(text)) return null;

  const value = Number(text);
  if (value < 1 || value > MAX_ALLOWED_UPLOAD_LIMIT_MB) return null;
  return value;
}

/** The largest upload a designer may send, in bytes (set with MAX_UPLOAD_MB). */
export function getUploadLimitBytes(): number {
  const megabytes =
    parseMegabytes(process.env.MAX_UPLOAD_MB) ?? DEFAULT_UPLOAD_LIMIT_MB;
  return megabytes * 1024 * 1024;
}
