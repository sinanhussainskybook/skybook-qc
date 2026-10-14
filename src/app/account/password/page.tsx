import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { requireSignedInUser } from "@/lib/auth/current-user";

export const metadata: Metadata = { title: "Change password · Skybook AI QC" };

/**
 * Change your own password. A user with a temporary password (set by an
 * administrator) is sent here by requireUser() and can't open anything else
 * until they have chosen their own.
 */
export default async function ChangePasswordPage() {
  const user = await requireSignedInUser();

  return (
    <AppShell
      user={user}
      hero={
        <>
          {!user.mustChangePassword && (
            <Link href="/" className="hero-glass mb-6 text-sm">
              <ArrowLeft className="size-4" aria-hidden />
              All companies
            </Link>
          )}
          <h1 className="display text-4xl sm:text-6xl">
            {user.mustChangePassword ? "Choose your own password" : "Change password"}
          </h1>
          <p className="mt-4 max-w-xl text-muted-foreground sm:text-lg">
            {user.mustChangePassword
              ? "Your administrator gave you a temporary password. Choose a new one to continue."
              : "Your other signed-in browsers will be signed out."}
          </p>
        </>
      }
    >
      <section className="mx-auto max-w-md">
        <ChangePasswordForm />
      </section>
    </AppShell>
  );
}
