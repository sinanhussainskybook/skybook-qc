import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LockKeyhole } from "lucide-react";
import { LoginForm } from "@/components/auth/login-form";
import { SkybookMark } from "@/components/layout/skybook-mark";
import { getCurrentUser } from "@/lib/auth/current-user";
import { safeRedirectPath } from "@/lib/auth/route-access";

export const metadata: Metadata = { title: "Sign in · Skybook AI QC" };

/**
 * The only page a signed-out visitor can open. There is no sign-up link:
 * accounts are created with `npm run user:create` (D2).
 */
export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  if (await getCurrentUser()) redirect("/");

  const { next } = await searchParams;
  const nextPath = safeRedirectPath(typeof next === "string" ? next : undefined);

  return (
    <main className="sky-backdrop flex min-h-dvh flex-1 flex-col items-center px-4 pt-12 pb-10 sm:pt-20">
      <div className="flex items-center gap-2.5 rounded-full bg-white/95 py-1.5 pr-4 pl-2 shadow-sm">
        <SkybookMark className="h-7 w-7" />
        <span className="text-sm font-semibold tracking-[0.14em]">SKYBOOK</span>
        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-[10px] tracking-[0.2em] text-secondary-foreground">
          AI QC
        </span>
      </div>

      <h1 className="mt-8 max-w-xl text-center text-3xl font-semibold tracking-tight text-balance text-white sm:text-5xl">
        Check it before the client does.
      </h1>
      <p className="mt-3 max-w-md text-center text-base text-pretty text-white/90">
        Quality control for Skybook&apos;s design team. Sign in to continue.
      </p>

      <section
        aria-labelledby="sign-in-heading"
        className="mt-10 w-full max-w-sm rounded-3xl bg-card p-6 shadow-[0_24px_60px_-20px_rgb(15_27_45/0.35)] ring-1 ring-black/5 sm:p-8"
      >
        <h2 id="sign-in-heading" className="text-lg font-semibold">
          Sign in
        </h2>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">
          Use the email and password your administrator gave you.
        </p>
        <LoginForm next={nextPath} />
      </section>

      <p className="mt-6 flex items-center gap-1.5 text-xs text-foreground/70">
        <LockKeyhole className="size-3.5" aria-hidden />
        Internal tool · Skybook staff only
      </p>
    </main>
  );
}
