"use client";

import { useActionState, useState } from "react";
import { Pencil, Plus, Power, PowerOff, Trash2 } from "lucide-react";
import {
  deleteListItemAction,
  saveListItemAction,
  setGoldenRuleActiveAction,
  type ListItemFormState,
} from "@/lib/company/actions";
import { LIST_SPECS, type FieldSpec, type ListKind } from "@/lib/company/fields";
import type { ListItems } from "@/lib/company/types";
import { Button } from "@/components/ui/button";
import { FieldInput } from "@/components/company/field-input";
import { ItemSummary } from "@/components/company/item-summary";
import { cn } from "@/lib/utils";

/**
 * A list of a company's items (colours, fonts, terms or Golden Rules) with
 * Add, Edit and Remove — and, for Golden Rules, Switch off / Switch on.
 * Every change goes through a server action that checks access again.
 */

type Item = ListItems[ListKind][number];

export function ListEditor({
  kind,
  companyId,
  items,
  emptyText,
}: {
  kind: ListKind;
  companyId: string;
  items: Item[];
  emptyText: string;
}) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const { singular } = LIST_SPECS[kind];

  return (
    <div className="space-y-3">
      {items.length === 0 && !adding && (
        <p className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">
          {emptyText}
        </p>
      )}

      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id}>
              {editingId === item.id ? (
                <ItemForm
                  kind={kind}
                  companyId={companyId}
                  item={item}
                  onDone={() => setEditingId(null)}
                />
              ) : (
                <ItemRow
                  kind={kind}
                  companyId={companyId}
                  item={item}
                  onEdit={() => {
                    setAdding(false);
                    setEditingId(item.id);
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <ItemForm kind={kind} companyId={companyId} onDone={() => setAdding(false)} />
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
          Add {singular}
        </Button>
      )}
    </div>
  );
}

function ItemRow({
  kind,
  companyId,
  item,
  onEdit,
}: {
  kind: ListKind;
  companyId: string;
  item: Item;
  onEdit: () => void;
}) {
  const inactive = "active" in item && !item.active;
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-border sm:flex-row sm:items-start",
        inactive && "bg-muted/60"
      )}
    >
      <div className={cn("min-w-0 flex-1", inactive && "opacity-70")}>
        <ItemSummary kind={kind} item={item} />
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="rounded-full"
          onClick={onEdit}
          aria-label={`Edit ${LIST_SPECS[kind].singular}`}
        >
          <Pencil aria-hidden />
          Edit
        </Button>
        {"active" in item && (
          <ActiveToggle companyId={companyId} itemId={item.id} active={item.active} />
        )}
        <RemoveButton kind={kind} companyId={companyId} itemId={item.id} />
      </div>
    </div>
  );
}

function ItemForm({
  kind,
  companyId,
  item,
  onDone,
}: {
  kind: ListKind;
  companyId: string;
  item?: Item;
  onDone: () => void;
}) {
  const [state, formAction, pending] = useActionState<ListItemFormState, FormData>(
    async (previous, formData) => {
      const result = await saveListItemAction(previous, formData);
      if (result.ok) onDone();
      return result;
    },
    {}
  );
  const { singular, fields } = LIST_SPECS[kind];
  const prefix = `${kind}-${item?.id ?? "new"}`;
  const values = item as Record<string, string | boolean | null> | undefined;

  return (
    <form
      action={formAction}
      noValidate
      className="space-y-4 rounded-xl bg-muted/60 p-4 ring-1 ring-border"
      aria-label={item ? `Edit ${singular}` : `Add ${singular}`}
    >
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="list" value={kind} />
      {item && <input type="hidden" name="itemId" value={item.id} />}

      <div className="grid gap-4 sm:grid-cols-2">
        {(Object.entries(fields) as [string, FieldSpec][]).map(([name, spec], index) => {
          const id = `${prefix}-${name}`;
          const hintId = spec.hint ? `${id}-hint` : undefined;
          const wide = spec.kind === "textarea" || spec.kind === "checkbox";
          const input = (
            <FieldInput
              spec={spec}
              id={id}
              name={name}
              defaultValue={values?.[name] ?? (spec.kind === "select" ? "" : null)}
              error={state.errors?.[name]}
              hintId={hintId}
              autoFocus={index === 0}
            />
          );
          return (
            <div key={name} className={wide ? "sm:col-span-2" : undefined}>
              {spec.kind === "checkbox" ? (
                <label htmlFor={id} className="flex items-center gap-2.5 text-sm font-medium">
                  {input}
                  {spec.label}
                </label>
              ) : (
                <>
                  <label htmlFor={id} className="mb-2 block text-sm font-medium">
                    {spec.label}
                    {spec.required && <span className="text-muted-foreground"> (required)</span>}
                  </label>
                  {input}
                </>
              )}
              {spec.hint && (
                <p id={hintId} className="mt-1.5 text-xs text-muted-foreground">
                  {spec.hint}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {state.error && (
        <p role="alert" className="text-sm font-medium text-fail">
          {state.error}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={pending} className="h-9 rounded-full px-4">
          {pending ? "Saving…" : item ? "Save changes" : `Add ${singular}`}
        </Button>
        <Button type="button" variant="ghost" className="h-9 rounded-full px-4" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ActiveToggle({
  companyId,
  itemId,
  active,
}: {
  companyId: string;
  itemId: string;
  active: boolean;
}) {
  const [state, formAction, pending] = useActionState(setGoldenRuleActiveAction, {});
  return (
    <form action={formAction}>
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="itemId" value={itemId} />
      <input type="hidden" name="active" value={String(!active)} />
      <Button type="submit" variant="ghost" size="sm" className="rounded-full" disabled={pending}>
        {active ? <PowerOff aria-hidden /> : <Power aria-hidden />}
        {active ? "Switch off" : "Switch on"}
      </Button>
      {state.error && (
        <span role="alert" className="ml-1 text-xs text-fail">
          {state.error}
        </span>
      )}
    </form>
  );
}

function RemoveButton({
  kind,
  companyId,
  itemId,
}: {
  kind: ListKind;
  companyId: string;
  itemId: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState(deleteListItemAction, {});
  const { singular } = LIST_SPECS[kind];

  if (!confirming) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="rounded-full text-fail hover:bg-fail-soft hover:text-fail"
        onClick={() => setConfirming(true)}
      >
        <Trash2 aria-hidden />
        Remove
      </Button>
    );
  }

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-1 rounded-full bg-fail-soft py-0.5 pr-0.5 pl-3">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="list" value={kind} />
      <input type="hidden" name="itemId" value={itemId} />
      <span className="text-xs font-medium text-fail">Remove this {singular}?</span>
      <Button
        type="submit"
        size="sm"
        disabled={pending}
        className="rounded-full bg-fail text-white hover:bg-fail/85"
      >
        Yes, remove
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="rounded-full"
        onClick={() => setConfirming(false)}
      >
        Cancel
      </Button>
      {state.error && (
        <span role="alert" className="text-xs text-fail">
          {state.error}
        </span>
      )}
    </form>
  );
}
