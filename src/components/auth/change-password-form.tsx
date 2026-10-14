"use client";

import { useActionState } from "react";
import { changePasswordAction, type ChangePasswordFormState } from "@/lib/auth/actions";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/auth/user-input";
import { FieldBlock } from "@/components/admin/create-user-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const inputClass = "h-11 rounded-xl bg-card px-3.5";

/** Current password, then the new one twice. All checks happen on the server. */
export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState<ChangePasswordFormState, FormData>(changePasswordAction, {});
  const errors = state.errors ?? {};

  return (
    <form action={formAction} noValidate className="space-y-5">
      <FieldBlock id="current-password" label="Current password" error={errors.currentPassword}>
        <Input id="current-password" name="currentPassword" type="password" required maxLength={PASSWORD_MAX_LENGTH} autoComplete="current-password" aria-invalid={errors.currentPassword ? true : undefined} className={inputClass} />
      </FieldBlock>
      <FieldBlock id="new-password" label="New password" error={errors.password} hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}>
        <Input id="new-password" name="password" type="password" required minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} autoComplete="new-password" aria-invalid={errors.password ? true : undefined} className={inputClass} />
      </FieldBlock>
      <FieldBlock id="new-password-again" label="Type the new password again">
        <Input id="new-password-again" name="passwordConfirmation" type="password" required maxLength={PASSWORD_MAX_LENGTH} autoComplete="new-password" className={inputClass} />
      </FieldBlock>
      {errors.form && <p role="alert" className="rounded-xl bg-fail-soft px-3.5 py-2.5 text-sm font-medium text-fail">{errors.form}</p>}
      <Button type="submit" disabled={pending} className="btn-glossy h-11 w-full rounded-full bg-foreground text-sm font-semibold text-background hover:bg-foreground/85">
        {pending ? "Saving…" : "Save new password"}
      </Button>
    </form>
  );
}
