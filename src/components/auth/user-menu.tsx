import { LogOut } from "lucide-react";
import { signOutAction } from "@/lib/auth/actions";
import { ROLE_LABELS } from "@/lib/auth/roles";
import type { User } from "@/lib/db/users";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/** Who is signed in, their role, and Sign out — at the right of the header. */
export function UserMenu({ user }: { user: Pick<User, "name" | "role"> }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="hidden min-w-0 items-center gap-2 sm:flex">
        <span className="truncate text-sm font-medium">{user.name}</span>
        <Badge variant="secondary">{ROLE_LABELS[user.role]}</Badge>
      </div>
      <form action={signOutAction}>
        <Button type="submit" variant="outline" size="sm">
          <LogOut aria-hidden />
          Sign out
        </Button>
      </form>
    </div>
  );
}
