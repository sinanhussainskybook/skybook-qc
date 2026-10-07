/**
 * HTTP security headers for Skybook AI QC.
 *
 * next.config.ts attaches these to every response. They live in their own
 * file so they can be unit-tested.
 */

export type HttpHeader = { key: string; value: string };

/** Headers that are the same in development and production. */
export const BASE_SECURITY_HEADERS: readonly HttpHeader[] = [
  // Treat every file as the type the server declares — important once
  // designers start uploading files.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // No other website may show QC pages inside a frame.
  { key: "X-Frame-Options", value: "DENY" },
  // Links to other sites reveal only our domain, not the page address.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // QC never needs the camera, microphone, location or payments.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
];

/** Tells browsers to use HTTPS only. Production-only: dev runs on plain http. */
export const HSTS_HEADER: HttpHeader = {
  key: "Strict-Transport-Security",
  value: "max-age=31536000; includeSubDomains",
};

export function getSecurityHeaders(isProduction: boolean): HttpHeader[] {
  return isProduction
    ? [...BASE_SECURITY_HEADERS, HSTS_HEADER]
    : [...BASE_SECURITY_HEADERS];
}
