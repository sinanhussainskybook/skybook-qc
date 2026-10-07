"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDatabase, isDatabaseConfigured } from "@/lib/db/client";
import { signIn, signOut } from "@/lib/auth/sign-in";
import {
  isProductionEnvironment,
  sessionCookieName,
  sessionCookieOptions,
} from "@/lib/auth/session-cookie";
import { LOGIN_PATH, safeRedirectPath } from "@/lib/auth/route-access";

/**
 * Server actions for the sign-in form and the sign-out button.
 * Next.js only accepts these from pages on this site (it checks the Origin).
 */

export type SignInFormState = { error?: string; email?: string };

const MESSAGES = {
  invalid: "Email or password is incorrect.",
  unavailable: "Sign-in isn't available right now. Please try again, or contact your administrator.",
};

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export async function signInAction(
  _previous: SignInFormState,
  formData: FormData
): Promise<SignInFormState> {
  const email = field(formData, "email");
  const password = field(formData, "password");
  const next = safeRedirectPath(field(formData, "next"));

  if (!email.trim() || !password) {
    return { error: "Enter your email and password.", email };
  }
  if (!isDatabaseConfigured()) {
    console.error("Sign-in failed: DATABASE_URL is not set.");
    return { error: MESSAGES.unavailable, email };
  }

  let result;
  try {
    result = await signIn(getDatabase(), { email, password });
  } catch (error) {
    // Details go to the server log only, never to the page.
    console.error("Sign-in failed:", error);
    return { error: MESSAGES.unavailable, email };
  }

  if (!result.ok) {
    if (result.reason === "throttled") {
      const minutes = Math.ceil(result.retryAfterSeconds / 60);
      return {
        error: `Too many sign-in attempts. Please wait ${minutes} minute${minutes === 1 ? "" : "s"} and try again.`,
        email,
      };
    }
    return { error: MESSAGES.invalid, email };
  }

  const isProduction = isProductionEnvironment();
  (await cookies()).set(
    sessionCookieName(isProduction),
    result.token,
    sessionCookieOptions(result.expiresAt, isProduction)
  );
  redirect(next);
}

export async function signOutAction(): Promise<void> {
  const cookieStore = await cookies();
  const name = sessionCookieName(isProductionEnvironment());
  const token = cookieStore.get(name)?.value;

  if (token && isDatabaseConfigured()) {
    try {
      await signOut(getDatabase(), token);
    } catch (error) {
      // The cookie is still removed below; the session row expires on its own.
      console.error("Sign-out could not remove the session:", error);
    }
  }
  cookieStore.delete(name);
  redirect(LOGIN_PATH);
}
