"use client";

import { useActionState, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { deleteRequirementAction, saveRequirementAction, type QcFormState } from "@/lib/qc/actions";
import { REQUIREMENT_TYPES, requirementTypeLabel } from "@/lib/qc/requirements";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { submitKeepingValues } from "@/components/qc/submit-keeping-values";

/**
 * What the client asked for, as a simple list with Add / Edit / Delete. There's
 * no per-item confirm: Confirm & Run QC (below) confirms the whole list.
 */

export type RequirementView = {
  id: string;
  type: string;
  label: string | null;
  expected_value: string;
  notes: string | null;
  mandatory: boolean;
  confirmed: boolean;
  source: "manual" | "extracted";
};

const BOX =
  "w-full rounded-xl border border-input bg-card px-3.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20";

export function RequirementsEditor({
  sessionId,
  requirements,
}: {
  sessionId: string;
  requirements: RequirementView[];
}) {
  const [adding, setAdding] = useState(requirements.length === 0);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      {requirements.length > 0 && (
        <ul className="space-y-2.5">
          {requirements.map((requirement) => (
            <li key={requirement.id}>
              {editingId === requirement.id ? (
                <RequirementForm
                  sessionId={sessionId}
                  requirement={requirement}
                  onDone={() => setEditingId(null)}
                />
              ) : (
                <RequirementCard
                  sessionId={sessionId}
                  requirement={requirement}
                  onEdit={() => {
                    setAdding(false);
                    setEditingId(requirement.id);
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <RequirementForm
          sessionId={sessionId}
          onDone={() => setAdding(false)}
          canCancel={requirements.length > 0}
        />
      ) : (
        <Button
          type="button"
          variant="outline"
          className="h-9 rounded-full px-4"
          onClick={() => {
            setEditingId(null);
            setAdding(true);
          }}
        >
          <Plus aria-hidden />
          Add requirement
        </Button>
      )}
    </div>
  );
}

function RequirementCard({
  sessionId,
  requirement,
  onEdit,
}: {
  sessionId: string;
  requirement: RequirementView;
  onEdit: () => void;
}) {
  const [deleteState, deleteAction, deleting] = useActionState(deleteRequirementAction, {});
  const [askDelete, setAskDelete] = useState(false);
  const title = requirement.label || requirementTypeLabel(requirement.type);
  const error = deleteState.error;

  return (
    <div className="rounded-xl bg-card p-4 ring-1 ring-border">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary">{requirementTypeLabel(requirement.type)}</Badge>
        {requirement.mandatory ? (
          <Badge className="bg-foreground text-background">Must have</Badge>
        ) : (
          <Badge variant="outline">Optional</Badge>
        )}
        {requirement.source === "extracted" && <Badge variant="outline">From the brief</Badge>}
      </div>

      {requirement.label && <p dir="auto" className="mt-2 text-xs font-medium text-muted-foreground">{title}</p>}
      <p dir="auto" className="mt-1.5 text-[15px] font-medium break-words whitespace-pre-line">{requirement.expected_value}</p>
      {requirement.notes && (
        <p dir="auto" className="mt-1.5 text-sm break-words whitespace-pre-line text-muted-foreground">{requirement.notes}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1">
        <Button type="button" variant="ghost" size="sm" className="rounded-full" onClick={onEdit}>
          <Pencil aria-hidden />
          Edit
        </Button>
        {askDelete ? (
          <form action={deleteAction} className="flex items-center gap-1 rounded-full bg-fail-soft py-0.5 pr-0.5 pl-3">
            <input type="hidden" name="sessionId" value={sessionId} />
            <input type="hidden" name="requirementId" value={requirement.id} />
            <span className="text-xs font-medium text-fail">Delete this requirement?</span>
            <Button type="submit" size="sm" disabled={deleting} className="rounded-full bg-fail text-white hover:bg-fail/85">
              Yes, delete
            </Button>
            <Button type="button" variant="ghost" size="sm" className="rounded-full" onClick={() => setAskDelete(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="rounded-full text-fail hover:bg-fail-soft hover:text-fail"
            onClick={() => setAskDelete(true)}
          >
            <Trash2 aria-hidden />
            Delete
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm font-medium text-fail">
          {error}
        </p>
      )}
    </div>
  );
}

function RequirementForm({
  sessionId,
  requirement,
  onDone,
  canCancel = true,
}: {
  sessionId: string;
  requirement?: RequirementView;
  onDone: () => void;
  canCancel?: boolean;
}) {
  const [state, formAction, pending] = useActionState<QcFormState, FormData>(async (previous, formData) => {
    const result = await saveRequirementAction(previous, formData);
    if (result.ok) onDone();
    return result;
  }, {});
  const prefix = `req-${requirement?.id ?? "new"}`;
  const err = state.errors ?? {};

  return (
    <form
      onSubmit={submitKeepingValues(formAction)}
      noValidate
      aria-label={requirement ? "Edit requirement" : "Add requirement"}
      className="space-y-4 rounded-xl bg-muted/60 p-4 ring-1 ring-border"
    >
      <input type="hidden" name="sessionId" value={sessionId} />
      {requirement && <input type="hidden" name="requirementId" value={requirement.id} />}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`${prefix}-type`} className="mb-2 block text-sm font-medium">
            Requirement type
          </label>
          <select
            id={`${prefix}-type`}
            name="type"
            defaultValue={requirement?.type ?? ""}
            aria-invalid={err.type ? true : undefined}
            className={cn(BOX, "h-10")}
          >
            <option value="" disabled>
              Choose…
            </option>
            {REQUIREMENT_TYPES.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </select>
          {err.type && <p className="mt-1.5 text-sm font-medium text-fail">{err.type}</p>}
        </div>
        <div>
          <label htmlFor={`${prefix}-label`} className="mb-2 block text-sm font-medium">
            Name <span className="text-muted-foreground">(optional)</span>
          </label>
          <Input
            id={`${prefix}-label`}
            name="label"
            maxLength={120}
            defaultValue={requirement?.label ?? ""}
            placeholder="e.g. Summer offer"
            className="h-10 rounded-xl bg-card px-3.5"
          />
          {err.label && <p className="mt-1.5 text-sm font-medium text-fail">{err.label}</p>}
        </div>
        <div className="sm:col-span-2">
          <label htmlFor={`${prefix}-value`} className="mb-2 block text-sm font-medium">
            Expected value <span className="text-muted-foreground">(required)</span>
          </label>
          <textarea
            dir="auto"
            id={`${prefix}-value`}
            name="expected_value"
            rows={2}
            maxLength={2000}
            defaultValue={requirement?.expected_value ?? ""}
            placeholder="Exactly what must appear, e.g. 20% off all villas"
            aria-invalid={err.expected_value ? true : undefined}
            className={cn(BOX, "min-h-16 py-2.5")}
            autoFocus
          />
          {err.expected_value && <p className="mt-1.5 text-sm font-medium text-fail">{err.expected_value}</p>}
        </div>
        <div className="sm:col-span-2">
          <label htmlFor={`${prefix}-notes`} className="mb-2 block text-sm font-medium">
            Notes <span className="text-muted-foreground">(optional)</span>
          </label>
          <textarea
            dir="auto"
            id={`${prefix}-notes`}
            name="notes"
            rows={2}
            maxLength={1000}
            defaultValue={requirement?.notes ?? ""}
            className={cn(BOX, "min-h-16 py-2.5")}
          />
          {err.notes && <p className="mt-1.5 text-sm font-medium text-fail">{err.notes}</p>}
        </div>
        <label className="flex items-center gap-2.5 text-sm font-medium">
          <input
            type="checkbox"
            name="mandatory"
            defaultChecked={requirement?.mandatory ?? true}
            className="size-4 accent-primary"
          />
          Must have <span className="font-normal text-muted-foreground">(untick for optional)</span>
        </label>
      </div>

      {state.error && (
        <p role="alert" className="text-sm font-medium text-fail">
          {state.error}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={pending} className="h-9 rounded-full px-4">
          {pending ? "Saving…" : requirement ? "Save changes" : "Save requirement"}
        </Button>
        {canCancel && (
          <Button type="button" variant="ghost" className="h-9 rounded-full px-4" onClick={onDone}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
