import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { CreateUserForm } from "@/components/admin/create-user-form";
import { UserActions } from "@/components/admin/user-actions";
import { Badge } from "@/components/ui/badge";
import { requireRole } from "@/lib/auth/current-user";
import { ROLE_LABELS } from "@/lib/auth/roles";
import { getDatabase } from "@/lib/db/client";
import { listUsers } from "@/lib/db/users";

export const metadata: Metadata = { title: "Users · Skybook AI QC" };

/**
 * User Management — administrators only. Anyone else gets "not found"
 * (requireRole), and every action on the page checks again on the server.
 * There is no public sign-up: accounts are created here or with
 * `npm run user:create`.
 */
export default async function UsersPage() {
  const admin = await requireRole("admin");
  const users = await listUsers(getDatabase());

  return (
    <AppShell user={admin}>
      <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden />
        All companies
      </Link>

      <h1 className="display mt-6 text-4xl">Users</h1>
      <p className="mt-3 max-w-2xl text-muted-foreground">
        Add staff, switch accounts on or off, set temporary passwords and delete accounts. A temporary password must be changed at the next sign-in.
      </p>

      <section aria-labelledby="add-user-title" className="mt-10 rounded-3xl bg-card p-6 ring-1 ring-foreground/8 sm:p-8">
        <h2 id="add-user-title" className="mb-5 text-lg font-semibold tracking-tight">Add a user</h2>
        <CreateUserForm />
      </section>

      <section aria-labelledby="all-users-title" className="mt-10">
        <h2 id="all-users-title" className="text-lg font-semibold tracking-tight">
          All users <span className="text-muted-foreground">({users.length})</span>
        </h2>
        <ul className="mt-4 divide-y divide-border rounded-3xl bg-card ring-1 ring-foreground/8">
          {users.map((user) => (
            <li key={user.id} className="grid gap-4 p-5 sm:grid-cols-[1fr_auto] sm:items-start sm:p-6">
              <div className="min-w-0">
                <p className="font-medium">
                  {user.name}
                  {user.id === admin.id && <span className="ml-2 text-sm text-muted-foreground">(you)</span>}
                </p>
                <p className="truncate text-sm text-muted-foreground">{user.email}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Badge variant="outline">{ROLE_LABELS[user.role]}</Badge>
                  {user.active ? <Badge variant="secondary">Active</Badge> : <Badge variant="destructive">Switched off</Badge>}
                  {user.mustChangePassword && <Badge variant="outline">Temporary password</Badge>}
                </div>
              </div>
              {user.id === admin.id ? (
                <Link href="/account/password" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
                  Change your password
                </Link>
              ) : (
                <UserActions user={{ id: user.id, name: user.name, email: user.email, active: user.active }} />
              )}
            </li>
          ))}
        </ul>
      </section>
    </AppShell>
  );
}
