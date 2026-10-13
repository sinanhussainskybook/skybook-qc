"use client";

import { useActionState } from "react";
import { createUserAction, type CreateUserFormState } from "@/lib/auth/user-admin-actions";
import { ROLE_LABELS, ROLES } from "@/lib/auth/roles";
import { EMAIL_MAX_LENGTH, NAME_MAX_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/auth/user-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const inputClass = "h-11 rounded-xl bg-card px-3.5";

/** Name, email, role and a temporary password. Every check is repeated on the server. */
export function CreateUserForm() {
  const [state, formAction, pending] = useActionState<CreateUserFormState, FormData>(createUserAction, {});
  const errors = state.errors ?? {};
  // A fresh, empty form after a user is added; the typed values back after an error.
  const key = state.ok ? `added-${state.message}` : JSON.stringify(state.values ?? {});

  return (
    <form action={formAction} noValidate className="grid gap-4 sm:grid-cols-2" key={key}>
      <FieldBlock id="new-user-name" label="Full name" error={errors.name}>
        <Input id="new-user-name" name="name" required maxLength={NAME_MAX_LENGTH} autoComplete="off" defaultValue={state.values?.name} aria-invalid={errors.name ? true : undefined} className={inputClass} />
      </FieldBlock>
      <FieldBlock id="new-user-email" label="Work email" error={errors.email}>
        <Input id="new-user-email" name="email" type="email" required maxLength={EMAIL_MAX_LENGTH} autoComplete="off" defaultValue={state.values?.email} aria-invalid={errors.email ? true : undefined} className={inputClass} />
      </FieldBlock>
      <FieldBlock id="new-user-role" label="Role" error={errors.role}>
        <select id="new-user-role" name="role" defaultValue={state.values?.role || "designer"} className={`${inputClass} w-full border border-input text-sm`}>
          {ROLES.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABELS[role]}
            </option>
          ))}
        </select>
      </FieldBlock>
      <div className="hidden sm:block" />
      <FieldBlock id="new-user-password" label="Temporary password" error={errors.password} hint={`At least ${PASSWORD_MIN_LENGTH} characters. They must change it when they first sign in.`}>
        <Input id="new-user-password" name="password" type="password" required minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} autoComplete="new-password" aria-invalid={errors.password ? true : undefined} className={inputClass} />
      </FieldBlock>
      <FieldBlock id="new-user-password-again" label="Type it again">
        <Input id="new-user-password-again" name="passwordConfirmation" type="password" required maxLength={PASSWORD_MAX_LENGTH} autoComplete="new-password" className={inputClass} />
      </FieldBlock>

      <div className="space-y-3 sm:col-span-2">
        {errors.form && <p role="alert" className="rounded-xl bg-fail-soft px-3.5 py-2.5 text-sm font-medium text-fail">{errors.form}</p>}
        {state.ok && <p role="status" className="rounded-xl bg-pass-soft px-3.5 py-2.5 text-sm font-medium text-pass">{state.message}</p>}
        <Button type="submit" disabled={pending} className="h-11 rounded-full bg-foreground px-6 text-sm font-semibold text-background hover:bg-foreground/85">
          {pending ? "Adding…" : "Add user"}
        </Button>
      </div>
    </form>
  );
}

export function FieldBlock({ id, label, error, hint, children }: { id: string; label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p role="alert" className="text-sm font-medium text-fail">{error}</p>
      ) : (
        hint && <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
