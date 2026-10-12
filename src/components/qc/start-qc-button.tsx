"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { startSessionAction, type QcFormState } from "@/lib/qc/actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Starts (or resumes) a QC check in one click and opens it. Design / Poster
 * and Social Media Post are checked identically (same files, rules and
 * platforms), so new checks are Design / Poster without asking.
 */
export function StartQcButton({ companyId, label = "Start a QC check", className }: { companyId: string; label?: string; className?: string }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<QcFormState, FormData>(async (previous, formData) => {
    const result = await startSessionAction(previous, formData);
    if (result.ok) router.push(`/companies/${companyId}/qc/new`);
    return result;
  }, {});
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="contentType" value="design_poster" />
      <Button type="submit" disabled={pending} className={cn("h-12 rounded-full px-6 text-base font-semibold", className)}>
        {pending ? "Starting…" : label}
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
