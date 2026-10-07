import type { ReactNode } from "react";
import Link from "next/link";
import { SkybookLogo } from "@/components/layout/skybook-mark";
import { UserMenu } from "@/components/auth/user-menu";
import type { User } from "@/lib/db/users";

/**
 * The frame every signed-in page sits in: the Skybook mark and the signed-in
 * user across the top, the page in the middle, and a small footer.
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
      <header className="sticky top-0 z-30 border-b border-border bg-card/90 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Link
            href="/"
            aria-label="Skybook AI QC, home"
            className="shrink-0 rounded-md transition-opacity hover:opacity-75"
          >
            <SkybookLogo sub="AI QC" />
          </Link>
          <div className="ml-auto">
            <UserMenu user={user} />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        {children}
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto w-full max-w-6xl px-4 py-4 text-xs text-muted-foreground sm:px-6">
          Skybook AI QC · Internal tool for the Skybook design team
        </div>
      </footer>
    </div>
  );
}
