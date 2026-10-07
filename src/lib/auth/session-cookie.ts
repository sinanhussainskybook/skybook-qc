/**
 * Name and settings of the sign-in cookie. No secrets here, so proxy.ts
 * can use it too.
 */

/**
 * In production the `__Host-` prefix makes the browser refuse the cookie
 * unless it is Secure, set by this exact host and for the whole site.
 */
export function sessionCookieName(isProduction: boolean): string {
  return isProduction ? "__Host-skybook_qc_session" : "skybook_qc_session";
}

export function sessionCookieOptions(expiresAt: Date, isProduction: boolean) {
  return {
    httpOnly: true, // page scripts can't read it
    secure: isProduction, // HTTPS only (development runs on plain http://localhost)
    sameSite: "lax" as const, // not sent with requests started by other sites
    path: "/",
    expires: expiresAt,
  };
}

export function isProductionEnvironment(): boolean {
  return process.env.NODE_ENV === "production";
}
