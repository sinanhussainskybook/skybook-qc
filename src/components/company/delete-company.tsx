"use client";

import { useActionState, useState } from "react";
import { Trash2 } from "lucide-react";
import { deleteCompanyAction, type DeleteCompanyState } from "@/lib/company/delete-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Delete company — shown to administrators only (the action checks again on
 * the server). A first click opens the confirmation; the company name must
 * be typed before the final button works.
 */
export function DeleteCompany({ company }: { company: { id: string; name: string } }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [state, formAction, pending] = useActionState<DeleteCompanyState, FormData>(deleteCompanyAction, {});
  const matches = typed.trim() === company.name.trim();

  if (!open) {
    return (
      <Button type="button" variant="destructive" className="h-9 rounded-full px-4" onClick={() => setOpen(true)}>
        <Trash2 aria-hidden />
        Delete company
      </Button>
    );
  }

  return (
    <form action={formAction} className="max-w-xl space-y-3 rounded-2xl bg-fail-soft p-5">
      <input type="hidden" name="companyId" value={company.id} />
      <p className="text-sm">
        Delete <strong>{company.name}</strong> permanently? Its information, contact details, logo, brand guidelines,
        Golden Rules, designer access and any QC check in progress are removed. This can&apos;t be undone.
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="confirm-company-name">Type {company.name} to confirm</Label>
        <Input
          id="confirm-company-name"
          name="confirmName"
          autoComplete="off"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          className="h-10 rounded-xl bg-card"
        />
      </div>
      {state.error && <p role="alert" className="text-sm font-medium text-fail">{state.error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending || !matches} className="h-9 rounded-full bg-fail px-4 text-white hover:bg-fail/85">
          {pending ? "Deleting…" : "Delete company"}
        </Button>
        <Button type="button" variant="outline" className="h-9 rounded-full px-4" onClick={() => { setOpen(false); setTyped(""); }}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
