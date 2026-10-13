import { signOutAction } from "@/lib/auth/actions";
import type { User } from "@/lib/db/users";
import { Button } from "@/components/ui/button";

/**
 * Who is signed in, and Sign out — at the right of the header. Home, Add
 * company and Users are in the main navigation (MainNav); changing your own
 * password is linked from the Users page.
 */
export function UserMenu({ user }: { user: Pick<User, "name" | "role"> }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="hidden truncate text-sm text-muted-foreground lg:block">{user.name}</span>
      <form action={signOutAction}>
        <Button type="submit" variant="outline" size="sm" className="h-8 rounded-full px-3.5">
          Sign out
        </Button>
      </form>
    </div>
  );
}
