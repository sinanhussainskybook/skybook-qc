"use client";

import { useActionState } from "react";
import { ArrowRight } from "lucide-react";
import { startSessionAction, type QcFormState } from "@/lib/qc/actions";
import { Button } from "@/components/ui/button";

/**
 * Starts a QC check in one click. Design / Poster and Social Media Post are
 * checked identically (same files, rules and platforms), so new checks are
 * Design / Poster without asking.
 */
export function StartQcButton({ companyId }: { companyId: string }) {
  const [state, formAction, pending] = useActionState<QcFormState, FormData>(startSessionAction, {});
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="contentType" value="design_poster" />
      <Button type="submit" disabled={pending} className="h-11 rounded-full px-6 text-sm font-semibold">
        {pending ? "Starting…" : "Start QC"}
        <ArrowRight aria-hidden />
      </Button>
      {state.error && (
        <p role="alert" className="text-sm font-medium text-fail">
          {state.error}
        </p>
      )}
    </form>
  );
}
