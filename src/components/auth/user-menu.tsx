import { signOutAction } from "@/lib/auth/actions";
import type { User } from "@/lib/db/users";
import { Button } from "@/components/ui/button";

/**
 * Who is signed in, and Sign out — at the right end of the navigation pill
 * (MainNav). Changing your own password is linked from the Users page.
 */
export function UserMenu({ user }: { user: Pick<User, "name" | "role"> }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="hidden max-w-[12rem] truncate px-1 text-sm text-white/70 md:block">{user.name}</span>
      <form action={signOutAction}>
        <Button type="submit" variant="outline" size="sm" className="h-9 rounded-full border-white/20 bg-white/10 px-4 text-white hover:bg-white/20 hover:text-white">
          Sign out
        </Button>
      </form>
    </div>
  );
}
