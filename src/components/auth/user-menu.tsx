import Link from "next/link";
import { signOutAction } from "@/lib/auth/actions";
import { CHANGE_PASSWORD_PATH, USERS_PATH } from "@/lib/auth/route-access";
import type { User } from "@/lib/db/users";
import { Button } from "@/components/ui/button";

const linkClass = "hidden text-sm text-muted-foreground hover:text-foreground sm:block";

/**
 * Who is signed in, Users (admins only — the page checks again on the
 * server), Password, and Sign out — at the right of the header.
 */
export function UserMenu({ user }: { user: Pick<User, "name" | "role"> }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="hidden truncate text-sm text-muted-foreground sm:block">{user.name}</span>
      {user.role === "admin" && (
        <Link href={USERS_PATH} className="text-sm text-muted-foreground hover:text-foreground">
          Users
        </Link>
      )}
      <Link href={CHANGE_PASSWORD_PATH} className={linkClass}>
        Password
      </Link>
      <form action={signOutAction}>
        <Button type="submit" variant="outline" size="sm" className="h-8 rounded-full px-3.5">
          Sign out
        </Button>
      </form>
    </div>
  );
}
