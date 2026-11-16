/**
 * HTTP security headers for Skybook AI QC.
 *
 * next.config.ts attaches the fixed headers to every response. The
 * Content-Security-Policy changes per request (a fresh nonce each time), so
 * proxy.ts adds it to pages. Both live here so they can be unit-tested.
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

/**
 * The Content-Security-Policy for pages. The browser may only:
 * - run scripts carrying this request's nonce (Next.js adds it to its own scripts; the theme script
 *   in layout.tsx adds it by hand), plus the scripts those load ('strict-dynamic'); no other inline
 *   or outside scripts, no plugins (<object>), no <base> tricks;
 * - load images from this site, data:/blob: images and the Supabase project (signed links to logos
 *   and designs); send requests to this site and Supabase (designs are uploaded straight to Storage);
 * - use this site's own fonts and styles (inline style attributes are allowed: React uses them);
 * - send forms to this site only, and never be shown inside another site's frame.
 * Development adds 'unsafe-eval' (Next.js's dev tools need it) and keeps plain http.
 */
export function contentSecurityPolicy(options: {
  nonce: string;
  isProduction: boolean;
  supabaseOrigin?: string | null;
}): string {
  const { nonce, isProduction, supabaseOrigin } = options;
  const supabase = supabaseOrigin ? ` ${supabaseOrigin}` : "";
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isProduction ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${supabase}`,
    "font-src 'self'",
    `connect-src 'self'${supabase}`,
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isProduction ? ["upgrade-insecure-requests"] : []),
  ];
  return directives.join("; ");
}

/** A fresh, unguessable nonce for one response (128 random bits, base64). */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/**
 * The Supabase project's origin (https://<ref>.supabase.co) from SUPABASE_URL, or null when it isn't
 * set or isn't a plain https address (http only for a local Supabase). Nothing else from the
 * environment goes into the policy.
 */
export function supabaseOriginFromEnv(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.SUPABASE_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol === "https:" || (local && url.protocol === "http:")) return url.origin;
  } catch {
    // not a URL
  }
  return null;
}
