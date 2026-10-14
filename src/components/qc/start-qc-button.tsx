"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { startNewCheckAction, startSessionAction, type QcFormState } from "@/lib/qc/actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Starts a QC check in one click and opens it. Design / Poster and Social
 * Media Post are checked identically (same files, rules and platforms), so
 * new checks are Design / Poster without asking.
 *
 * An unfinished check for this company is opened again (within its 24
 * hours). A COMPLETED one is never reopened — the server says so, and the
 * designer confirms before its brief, design and results are deleted and a
 * fresh, empty check starts.
 */
export function StartQcButton({ companyId, label = "Start a QC check", className }: { companyId: string; label?: string; className?: string }) {
  const router = useRouter();
  const open = () => router.push(`/companies/${companyId}/qc/new`);
  const [confirmFor, setConfirmFor] = useState<string | null>(null);

  const [state, formAction, pending] = useActionState<QcFormState, FormData>(async (previous, formData) => {
    const result = await startSessionAction(previous, formData);
    if (result.confirmNewCheck) setConfirmFor(result.confirmNewCheck.sessionId);
    else if (result.ok) open();
    return result;
  }, {});
  const [newState, newAction, newPending] = useActionState<QcFormState, FormData>(async (previous, formData) => {
    const result = await startNewCheckAction(previous, formData);
    if (result.ok) open();
    return result;
  }, {});

  if (confirmFor) {
    return (
      <form action={newAction} className="hero-light flex max-w-xl flex-col items-center gap-3 rounded-3xl bg-white/95 p-5 text-foreground shadow-lg">
        <input type="hidden" name="companyId" value={companyId} />
        <input type="hidden" name="sessionId" value={confirmFor} />
        <input type="hidden" name="contentType" value="design_poster" />
        <p className="text-sm">
          Your last QC check for this company is finished. A new check starts empty — the last check&apos;s brief,
          design and results will be deleted.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button type="submit" disabled={newPending} className={cn("h-11 rounded-full px-5 text-sm font-semibold", className)}>
            {newPending ? "Starting…" : "Start a new check"}
            <ArrowRight aria-hidden />
          </Button>
          <Button type="button" variant="outline" disabled={newPending} className="btn-white h-11 rounded-full px-5" onClick={() => setConfirmFor(null)}>
            Cancel
          </Button>
        </div>
        {newState.error && (
          <p role="alert" className="text-sm font-medium text-fail">
            {newState.error}
          </p>
        )}
      </form>
    );
  }

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
