/**
 * Who may reach which URL, as decided by proxy.ts before a page loads.
 *
 * This is only a quick first filter based on whether a sign-in cookie is
 * present. The real check — is the session valid, is the account active —
 * happens on the server in requireUser() (current-user.ts).
 */

/** The only pages a signed-out visitor may open. */
export const PUBLIC_PATHS: readonly string[] = ["/login"];

export const LOGIN_PATH = "/login";

export type RouteAccess = "allow" | "redirect-to-login" | "unauthorized";

export function decideRouteAccess(pathname: string, hasSessionCookie: boolean): RouteAccess {
  if (PUBLIC_PATHS.includes(pathname) || hasSessionCookie) return "allow";
  return pathname === "/api" || pathname.startsWith("/api/")
    ? "unauthorized"
    : "redirect-to-login";
}

/**
 * Where to go after signing in. Only a path on this site is accepted, so a
 * crafted link like /login?next=https://evil.example can't send someone away.
 */
export function safeRedirectPath(raw: unknown, fallback = "/"): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return fallback;

  const base = "http://qc.invalid";
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return fallback;
  }
  if (url.origin !== base || url.pathname === LOGIN_PATH) return fallback;
  return url.pathname + url.search;
}
