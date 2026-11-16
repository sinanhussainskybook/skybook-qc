"use client";

import { useActionState, useState, type ReactNode } from "react";
import { Check, Pencil } from "lucide-react";
import { saveCompanyFieldAction, type FieldFormState } from "@/lib/company/actions";
import { findFieldSpec, type FieldSection } from "@/lib/company/fields";
import { Button } from "@/components/ui/button";
import { FieldInput } from "@/components/company/field-input";

/**
 * One saved value with its own Edit button. Edit opens a small form for
 * just this field; Save sends it to the server, which checks it and saves
 * it for this company only.
 */
export function EditableField({
  companyId,
  section,
  field,
  value,
}: {
  companyId: string;
  section: FieldSection;
  field: string;
  value: string | null;
}) {
  const spec = findFieldSpec(section, field);
  const [editing, setEditing] = useState(false);
  const [dismissed, setDismissed] = useState<FieldFormState | null>(null);
  const [state, formAction, pending] = useActionState<FieldFormState, FormData>(
    async (previous, formData) => {
      const result = await saveCompanyFieldAction(previous, formData);
      if (result.ok) setEditing(false);
      return result;
    },
    {}
  );
  if (!spec) return null;

  const id = `${section}-${field}`;
  const hintId = spec.hint ? `${id}-hint` : undefined;
  const error = state !== dismissed ? state.error : undefined;

  if (editing) {
    return (
      <form
        action={formAction}
        noValidate
        className="rounded-xl bg-muted/60 p-4 ring-1 ring-border"
      >
        <input type="hidden" name="companyId" value={companyId} />
        <input type="hidden" name="section" value={section} />
        <input type="hidden" name="field" value={field} />
        <label htmlFor={id} className="mb-2 block text-sm font-medium">
          {spec.label}
          {spec.required && <span className="text-muted-foreground"> (required)</span>}
        </label>
        <FieldInput
          spec={spec}
          id={id}
          name="value"
          defaultValue={value}
          error={error}
          hintId={hintId}
          autoFocus
        />
        {spec.hint && (
          <p id={hintId} className="mt-1.5 text-xs text-muted-foreground">
            {spec.hint}
          </p>
        )}
        <div className="mt-3 flex gap-2">
          <Button type="submit" disabled={pending} className="h-9 rounded-full px-4">
            {pending ? "Saving…" : "Save"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="h-9 rounded-full px-4"
            onClick={() => {
              setDismissed(state);
              setEditing(false);
            }}
          >
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  const justSaved = state.ok && state !== dismissed;
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[13rem_1fr_auto] sm:items-start sm:gap-4">
      <div className="text-sm font-medium text-muted-foreground">{spec.label}</div>
      <div dir="auto" className="min-w-0 text-sm break-words whitespace-pre-line">
        {value ?? <span className="text-muted-foreground italic">Not set</span>}
        {justSaved && (
          <span className="ml-2 inline-flex items-center gap-1 text-xs font-medium text-pass">
            <Check className="size-3.5" aria-hidden /> Saved
          </span>
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="justify-self-start rounded-full sm:justify-self-end"
        aria-label={`Edit ${spec.label}`}
        onClick={() => {
          setDismissed(state);
          setEditing(true);
        }}
      >
        <Pencil aria-hidden />
        Edit
      </Button>
    </div>
  );
}

/** A list of editable fields with dividers between them. */
export function EditableFieldList({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-border">{children}</div>;
}
