"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, RotateCcw } from "lucide-react";
import { startNewCheckAction, type QcFormState } from "@/lib/qc/actions";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Shown on the company page while the designer has a QC check in progress
 * for this company (a session that hasn't expired):
 *   - Continue QC check — just opens it; nothing in the session changes.
 *   - Start a new check — after a confirmation, Start over removes that
 *     session's brief, design and results, then a fresh check opens.
 */
export function ContinueQc({ companyId, sessionId, hoursLeft }: { companyId: string; sessionId: string; hoursLeft: number }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState<QcFormState, FormData>(async (previous, formData) => {
    const result = await startNewCheckAction(previous, formData);
    if (result.ok) router.push(`/companies/${companyId}/qc/new`);
    return result;
  }, {});

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          href={`/companies/${companyId}/qc/new`}
          className={cn(buttonVariants(), "btn-glossy h-12 rounded-full px-6 text-base font-semibold")}
        >
          Continue QC check
          <ArrowRight aria-hidden />
        </Link>
        {!confirming && (
          <Button type="button" variant="outline" className="btn-white h-12 rounded-full px-5 text-base font-semibold" onClick={() => setConfirming(true)}>
            <RotateCcw aria-hidden />
            Start a new check
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {hoursLeft} hour{hoursLeft === 1 ? "" : "s"} left — deleted automatically unless you make a change.
      </p>

      {confirming && (
        <form action={formAction} className="flex flex-wrap items-center justify-center gap-2 rounded-full bg-fail-soft py-1 pr-1 pl-4">
          <input type="hidden" name="companyId" value={companyId} />
          <input type="hidden" name="sessionId" value={sessionId} />
          <input type="hidden" name="contentType" value="design_poster" />
          <span className="text-sm font-medium text-fail">Delete this check&apos;s brief and design?</span>
          <Button type="submit" size="sm" disabled={pending} className="rounded-full bg-fail text-white hover:bg-fail/85">
            {pending ? "Starting…" : "Start a new check"}
          </Button>
          <Button type="button" variant="ghost" size="sm" className="rounded-full" disabled={pending} onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </form>
      )}
      {state.error && (
        <p role="alert" className="text-sm font-medium text-fail">
          {state.error}
        </p>
      )}
    </div>
  );
}
