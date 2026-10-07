import { NextResponse, type NextRequest } from "next/server";
import { decideRouteAccess, LOGIN_PATH } from "@/lib/auth/route-access";
import { isProductionEnvironment, sessionCookieName } from "@/lib/auth/session-cookie";

/**
 * Runs before every request. A visitor without a sign-in cookie is sent to
 * /login (or gets 401 from an API route) before any page code runs.
 *
 * This only looks at whether the cookie exists — it does not touch the
 * database. The real check is requireUser() on the server.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasCookie = request.cookies.has(sessionCookieName(isProductionEnvironment()));

  switch (decideRouteAccess(pathname, hasCookie)) {
    case "allow":
      return NextResponse.next();
    case "unauthorized":
      return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    case "redirect-to-login": {
      const url = new URL(LOGIN_PATH, request.url);
      if (pathname !== "/") url.searchParams.set("next", pathname + search);
      return NextResponse.redirect(url);
    }
  }
}

export const config = {
  // Everything except Next.js build files and the site icon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
