"use client";

import type { FieldSpec } from "@/lib/company/fields";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * The input for one field, chosen by its spec (text, textarea, select …).
 * Browser validation is off on these forms (noValidate) so every message
 * comes from the server's own checks.
 */

const BOX =
  "w-full rounded-xl border border-input bg-card px-3.5 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20";

export function FieldInput({
  spec,
  id,
  name,
  defaultValue,
  error,
  hintId,
  autoFocus,
}: {
  spec: FieldSpec;
  id: string;
  name: string;
  defaultValue?: string | boolean | null;
  error?: string;
  hintId?: string;
  autoFocus?: boolean;
}) {
  const errorId = `${id}-error`;
  const describedBy = [error ? errorId : null, hintId].filter(Boolean).join(" ") || undefined;
  const common = {
    id,
    name,
    autoFocus,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
  };

  let control;
  switch (spec.kind) {
    case "textarea":
      control = (
        <textarea
          dir="auto"
          {...common}
          rows={3}
          maxLength={spec.maxLength}
          placeholder={spec.placeholder}
          defaultValue={typeof defaultValue === "string" ? defaultValue : ""}
          className={cn(BOX, "min-h-24 py-2.5")}
        />
      );
      break;
    case "select":
      control = (
        <select
          {...common}
          defaultValue={typeof defaultValue === "string" ? defaultValue : ""}
          className={cn(BOX, "h-10")}
        >
          <option value="" disabled>
            Choose…
          </option>
          {spec.choices?.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      );
      break;
    case "checkbox":
      control = (
        <input
          {...common}
          type="checkbox"
          defaultChecked={defaultValue === true}
          className="size-4 accent-primary"
        />
      );
      break;
    default:
      control = (
        <Input
          {...common}
          type={spec.kind === "url" ? "text" : spec.kind}
          inputMode={spec.kind === "url" ? "url" : undefined}
          maxLength={spec.maxLength}
          placeholder={spec.placeholder}
          defaultValue={typeof defaultValue === "string" ? defaultValue : ""}
          className="h-10 rounded-xl bg-card px-3.5"
        />
      );
  }

  return (
    <>
      {control}
      {error && (
        <p id={errorId} className="mt-1.5 text-sm font-medium text-fail">
          {error}
        </p>
      )}
    </>
  );
}
