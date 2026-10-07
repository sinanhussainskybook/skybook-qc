import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getDatabase, isDatabaseConfigured } from "@/lib/db/client";
import type { User } from "@/lib/db/users";
import { hasRole, type Role } from "@/lib/auth/roles";
import { getSessionUser } from "@/lib/auth/sign-in";
import { isProductionEnvironment, sessionCookieName } from "@/lib/auth/session-cookie";
import { LOGIN_PATH } from "@/lib/auth/route-access";

/**
 * The signed-in user, checked on the server against the database.
 * Every protected page, server action and API route calls requireUser()
 * (or requireRole()) itself — the proxy's cookie check is not enough.
 */

/** The current user, or null. Checked once per request (React cache). */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const token = (await cookies()).get(sessionCookieName(isProductionEnvironment()))?.value;
  if (!token || !isDatabaseConfigured()) return null;
  return getSessionUser(getDatabase(), token);
});

/** The current user; a signed-out visitor is sent to the sign-in page. */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect(LOGIN_PATH);
  return user;
}

/**
 * The current user, if they have `role`. Anyone else gets "not found", so
 * admin-only pages don't reveal that they exist.
 */
export async function requireRole(role: Role): Promise<User> {
  const user = await requireUser();
  if (!hasRole(user, role)) notFound();
  return user;
}
