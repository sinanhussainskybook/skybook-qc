import type { ReactNode } from "react";
import Link from "next/link";
import { SkybookLogo } from "@/components/layout/skybook-mark";
import { UserMenu } from "@/components/auth/user-menu";
import { MainNav } from "@/components/layout/main-nav";
import type { User } from "@/lib/db/users";

/**
 * The frame every signed-in page sits in: the Skybook mark on the left, the
 * main navigation (Home, Add company, Users for admins) in the middle, the
 * signed-in user and Sign out on the right, and the page below.
 *
 * The page passes in the user it got from requireUser(); the shell does no
 * checking of its own.
 */
export function AppShell({
  children,
  user,
}: {
  children: ReactNode;
  user: Pick<User, "name" | "role">;
}) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="sticky top-0 z-30 border-b border-border/70 bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center gap-4 px-4 sm:px-6">
          <Link href="/" aria-label="Skybook AI QC, home" className="shrink-0 rounded-md transition-opacity hover:opacity-75">
            <SkybookLogo sub="AI QC" />
          </Link>
          <div className="flex flex-1 justify-center">
            <MainNav role={user.role} />
          </div>
          <div className="shrink-0">
            <UserMenu user={user} />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-8 pb-20 sm:px-6 sm:pt-12">{children}</main>
    </div>
  );
}
