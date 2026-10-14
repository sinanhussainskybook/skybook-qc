import type { ReactNode } from "react";
import Link from "next/link";
import { SkybookLogo } from "@/components/layout/skybook-mark";
import { UserMenu } from "@/components/auth/user-menu";
import { MainNav } from "@/components/layout/main-nav";
import type { User } from "@/lib/db/users";

/**
 * The frame every signed-in page sits in: the Skybook mark on the left, the
 * main navigation pill on the right (Home, Users for admins, then the
 * signed-in user and Sign out), and the page below.
 *
 * `hero`: the page's title, intro and main action, centred in white on the
 * navy-to-blue hero; the page's content (`children`) then sits in a white
 * panel overlapping the hero's lower edge. Visual only.
 *
 * The page passes in the user it got from requireUser(); the shell does no
 * checking of its own.
 */
export function AppShell({
  children,
  hero,
  user,
}: {
  children?: ReactNode;
  hero?: ReactNode;
  user: Pick<User, "name" | "role">;
}) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="app-header sticky top-0 z-30">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center gap-4 px-4 sm:px-6">
          <Link href="/" aria-label="Skybook AI QC, home" className="shrink-0 rounded-md transition-opacity hover:opacity-75">
            <SkybookLogo sub="AI QC" className="text-white [&_.text-muted-foreground]:text-white/60" />
          </Link>
          <div className="ml-auto">
            <MainNav role={user.role}>
              <UserMenu user={user} />
            </MainNav>
          </div>
        </div>
      </header>

      {hero ? (
        <main className="flex-1">
          <section className="app-hero">
            <div className={`mx-auto flex w-full max-w-5xl flex-col items-center px-4 pt-10 text-center sm:px-6 sm:pt-14 ${children ? "pb-36 sm:pb-40" : "pb-24"}`}>
              {hero}
            </div>
          </section>
          {children && (
            <div className="relative mx-auto -mt-28 w-full max-w-5xl px-4 pb-20 sm:-mt-32 sm:px-6">
              <div className="content-panel p-5 sm:p-8">{children}</div>
            </div>
          )}
        </main>
      ) : (
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-8 pb-20 sm:px-6 sm:pt-12">{children}</main>
      )}
    </div>
  );
}
