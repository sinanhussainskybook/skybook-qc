"use client";

import { useActionState } from "react";
import { createCompanyAction, type CreateCompanyState } from "@/lib/company/actions";
import { COMPANY_NAME_MAX_LENGTH } from "@/lib/company/validation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Name only — everything else is added on the company page afterwards. */
export function AddCompanyForm() {
  const [state, formAction, pending] = useActionState<CreateCompanyState, FormData>(
    createCompanyAction,
    {}
  );

  return (
    <form action={formAction} noValidate className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="company-name">Company name</Label>
        <Input
          id="company-name"
          name="name"
          required
          maxLength={COMPANY_NAME_MAX_LENGTH}
          defaultValue={state.name}
          key={state.name}
          autoFocus
          autoComplete="off"
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? "company-name-error" : "company-name-hint"}
          className="h-11 rounded-xl bg-card px-3.5"
        />
        {state.error ? (
          <p id="company-name-error" role="alert" className="text-sm font-medium text-fail">
            {state.error}
          </p>
        ) : (
          <p id="company-name-hint" className="text-xs text-muted-foreground">
            As the client writes it. You can change it later.
          </p>
        )}
      </div>
      <Button
        type="submit"
        disabled={pending}
        className="btn-glossy h-11 w-full rounded-full bg-foreground text-sm font-semibold text-background hover:bg-foreground/85"
      >
        {pending ? "Adding…" : "Add company"}
      </Button>
    </form>
  );
}
