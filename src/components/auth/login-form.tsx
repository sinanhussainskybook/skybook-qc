"use client";

import { useActionState, useState } from "react";
import { Eye, EyeOff, LoaderCircle } from "lucide-react";
import { signInAction, type SignInFormState } from "@/lib/auth/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Email + password form. All checks happen on the server (signInAction);
 * this only shows the result. The error never says whether the email or
 * the password was wrong.
 */
export function LoginForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState<SignInFormState, FormData>(
    signInAction,
    {}
  );
  const [email, setEmail] = useState(state.email ?? "");
  const [showPassword, setShowPassword] = useState(false);
  const hasError = Boolean(state.error);

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="next" value={next} />

      <div className="space-y-2">
        <Label htmlFor="email">Work email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          inputMode="email"
          required
          maxLength={254}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={hasError || undefined}
          aria-describedby={hasError ? "sign-in-error" : undefined}
          className="h-11 rounded-xl bg-card px-3.5"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <div className="relative">
          <Input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
            maxLength={128}
            aria-invalid={hasError || undefined}
            aria-describedby={hasError ? "sign-in-error" : undefined}
            className="h-11 rounded-xl bg-card px-3.5 pr-11"
          />
          <button
            type="button"
            onClick={() => setShowPassword((shown) => !shown)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            aria-pressed={showPassword}
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-xl text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </div>

      <p
        id="sign-in-error"
        role="alert"
        aria-live="assertive"
        className={
          hasError
            ? "rounded-xl bg-fail-soft px-3.5 py-2.5 text-sm font-medium text-fail"
            : "sr-only"
        }
      >
        {state.error}
      </p>

      <Button
        type="submit"
        disabled={pending}
        className="h-11 w-full rounded-full bg-foreground text-sm font-semibold text-background hover:bg-foreground/85"
      >
        {pending && <LoaderCircle className="animate-spin" aria-hidden />}
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
