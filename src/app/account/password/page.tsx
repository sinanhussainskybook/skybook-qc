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
    <AppShell user={user}>
      {!user.mustChangePassword && (
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden />
          All companies
        </Link>
      )}
      <section className="mx-auto mt-8 max-w-md rounded-3xl bg-card p-6 ring-1 ring-foreground/8 sm:p-8">
        <h1 className="text-xl font-semibold tracking-tight">
          {user.mustChangePassword ? "Choose your own password" : "Change password"}
        </h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">
          {user.mustChangePassword
            ? "Your administrator gave you a temporary password. Choose a new one to continue."
            : "Your other signed-in browsers will be signed out."}
        </p>
        <ChangePasswordForm />
      </section>
    </AppShell>
  );
}
