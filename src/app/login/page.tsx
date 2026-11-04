import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/login-form";
import { SkybookLogo } from "@/components/layout/skybook-mark";
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
    <main className="login-hero flex min-h-dvh flex-1 flex-col px-4 py-8 sm:px-8">
      <SkybookLogo sub="AI QC" className="theme-logo text-white [&_.text-muted-foreground]:text-white/60" />

      <div className="mx-auto grid w-full max-w-5xl flex-1 items-center gap-12 py-12 lg:grid-cols-[1.15fr_1fr] lg:gap-20">
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
          <h1 className="display text-5xl sm:text-6xl lg:text-7xl">
            Check it before <span className="theme-link text-[#9cc2ff]">the client does.</span>
          </h1>
          <p className="mt-6 max-w-md text-lg text-white/75 theme-muted">
            Upload the brief and the design. Get a clear result and what to fix — in seconds.
          </p>
        </div>

        <section aria-labelledby="sign-in-heading" className="w-full max-w-sm rounded-3xl border border-white/30 bg-white p-6 text-foreground shadow-[0_30px_80px_-20px_rgb(2_6_23/0.6)] sm:p-8 lg:justify-self-end">
          <h2 id="sign-in-heading" className="text-xl font-semibold tracking-tight">
            Sign in
          </h2>
          <p className="mt-1 mb-6 text-sm text-muted-foreground">Use the email and password your administrator gave you.</p>
          <LoginForm next={nextPath} />
        </section>
      </div>

      <p className="text-center text-xs text-white/70 theme-muted">Internal tool · Skybook staff only</p>
    </main>
  );
}
