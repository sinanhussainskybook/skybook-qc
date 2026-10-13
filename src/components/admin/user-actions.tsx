"use client";

import { useActionState, useState } from "react";
import {
  deleteUserAction,
  resetPasswordAction,
  setUserActiveAction,
  type UserActionState,
} from "@/lib/auth/user-admin-actions";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/auth/user-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The buttons on one user's row. They are only shown for other users' rows
 * (never your own); the server refuses self-changes and the last active admin
 * whatever the page shows.
 */
export function UserActions({ user }: { user: { id: string; name: string; email: string; active: boolean } }) {
  const [open, setOpen] = useState<"reset" | "delete" | null>(null);
  const [activeState, activeAction, activePending] = useActionState<UserActionState, FormData>(setUserActiveAction, {});
  const toggle = (panel: "reset" | "delete") => setOpen((current) => (current === panel ? null : panel));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <form action={activeAction}>
          <input type="hidden" name="userId" value={user.id} />
          <input type="hidden" name="active" value={user.active ? "false" : "true"} />
          <Button type="submit" variant="outline" size="sm" disabled={activePending} className="rounded-full px-3">
            {user.active ? "Switch off" : "Switch on"}
          </Button>
        </form>
        <Button type="button" variant="outline" size="sm" className="rounded-full px-3" aria-expanded={open === "reset"} onClick={() => toggle("reset")}>
          Reset password
        </Button>
        <Button type="button" variant="destructive" size="sm" className="rounded-full px-3" aria-expanded={open === "delete"} onClick={() => toggle("delete")}>
          Delete
        </Button>
      </div>
      <Outcome state={activeState} />
      {open === "reset" && <ResetPasswordPanel user={user} />}
      {open === "delete" && <DeletePanel user={user} onCancel={() => setOpen(null)} />}
    </div>
  );
}

function ResetPasswordPanel({ user }: { user: { id: string; name: string } }) {
  const [state, formAction, pending] = useActionState<UserActionState, FormData>(resetPasswordAction, {});
  const id = `reset-${user.id}`;
  return (
    <form action={formAction} noValidate className="space-y-3 rounded-2xl bg-muted/50 p-4" key={state.ok ? "done" : "form"}>
      <input type="hidden" name="userId" value={user.id} />
      <p className="text-sm">
        A temporary password for <strong>{user.name}</strong>. They are signed out now and must choose their own when they next sign in.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-pw`}>Temporary password</Label>
          <Input id={`${id}-pw`} name="password" type="password" minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} autoComplete="new-password" className="h-10 rounded-xl bg-card" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-pw2`}>Type it again</Label>
          <Input id={`${id}-pw2`} name="passwordConfirmation" type="password" maxLength={PASSWORD_MAX_LENGTH} autoComplete="new-password" className="h-10 rounded-xl bg-card" />
        </div>
      </div>
      <Button type="submit" size="sm" disabled={pending} className="rounded-full px-3.5">
        {pending ? "Saving…" : "Set temporary password"}
      </Button>
      <Outcome state={state} />
    </form>
  );
}

function DeletePanel({ user, onCancel }: { user: { id: string; name: string; email: string }; onCancel: () => void }) {
  const [state, formAction, pending] = useActionState<UserActionState, FormData>(deleteUserAction, {});
  const [typed, setTyped] = useState("");
  const id = `delete-${user.id}`;
  const matches = typed.trim().toLowerCase() === user.email;
  return (
    <form action={formAction} className="space-y-3 rounded-2xl bg-fail-soft p-4">
      <input type="hidden" name="userId" value={user.id} />
      <p className="text-sm">
        Delete <strong>{user.name}</strong> permanently? Their account and company access are removed; companies they added are kept. This can&apos;t be undone — to stop them signing in for now, use <em>Switch off</em> instead.
      </p>
      <div className="space-y-1.5">
        <Label htmlFor={id}>Type {user.email} to confirm</Label>
        <Input id={id} name="confirmEmail" autoComplete="off" value={typed} onChange={(event) => setTyped(event.target.value)} className="h-10 rounded-xl bg-card" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={pending || !matches} className="rounded-full bg-fail px-3.5 text-white hover:bg-fail/85">
          {pending ? "Deleting…" : "Delete user"}
        </Button>
        <Button type="button" variant="outline" size="sm" className="rounded-full px-3.5" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <Outcome state={state} />
    </form>
  );
}

function Outcome({ state }: { state: UserActionState }) {
  if (state.error) return <p role="alert" className="text-sm font-medium text-fail">{state.error}</p>;
  if (state.ok) return <p role="status" className="text-sm font-medium text-pass">{state.message}</p>;
  return null;
}
