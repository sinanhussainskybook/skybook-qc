import { CircleCheck, CircleHelp, CircleX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { severityLabel, type Finding } from "@/lib/qc/findings";
import { cn } from "@/lib/utils";

/**
 * Platform / Size findings (5.11): what failed (Expected / Detected / Issue /
 * Suggested fix), what couldn't be verified, and how many checks passed.
 * No score here — the result is in the QC result section (scoreboard.tsx).
 */
export function PlatformCheck({ findings }: { findings: Finding[] }) {
  const failed = findings.filter((f) => f.status === "failed");
  const unverified = findings.filter((f) => f.status === "unverified");
  const passed = findings.filter((f) => f.status === "passed");

  return (
    <div className="space-y-4">
      <p className="flex flex-wrap gap-2 text-sm" aria-label="Summary">
        <span className="rounded-full bg-fail-soft px-3 py-1 font-medium text-fail">{failed.length} to fix</span>
        <span className="rounded-full bg-muted px-3 py-1 font-medium text-muted-foreground">
          {unverified.length} not verified
        </span>
        <span className="rounded-full bg-pass-soft px-3 py-1 font-medium text-pass">{passed.length} passed</span>
      </p>

      {failed.length > 0 && (
        <ul className="space-y-3" aria-label="Issues">
          {failed.map((f, i) => (
            <li key={`${f.ruleId}-${f.fileId ?? ""}-${i}`} className="rounded-xl bg-card p-4 ring-1 ring-border">
              <div className="flex flex-wrap items-center gap-2">
                <CircleX className="size-4 text-fail" aria-hidden />
                <span className="font-semibold">{f.title}</span>
                <Badge
                  variant="outline"
                  className={cn(f.severity === "suggestion" ? "text-muted-foreground" : "border-fail/40 text-fail")}
                >
                  {severityLabel(f.severity)}
                </Badge>
                {f.fileName && <span className="truncate text-xs text-muted-foreground">{f.fileName}</span>}
              </div>
              <dl className="mt-3 grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[8rem_1fr]">
                <dt className="text-muted-foreground">Expected</dt>
                <dd>{f.expected ?? "—"}</dd>
                <dt className="text-muted-foreground">Detected</dt>
                <dd>{f.detected ?? "—"}</dd>
                <dt className="text-muted-foreground">Issue</dt>
                <dd>{f.explanation}</dd>
                {f.suggestedFix && (
                  <>
                    <dt className="text-muted-foreground">Suggested fix</dt>
                    <dd>{f.suggestedFix}</dd>
                  </>
                )}
              </dl>
            </li>
          ))}
        </ul>
      )}

      {unverified.length > 0 && (
        <ul className="space-y-2" aria-label="Not verified">
          {unverified.map((f, i) => (
            <li key={`${f.ruleId}-${f.fileId ?? ""}-${i}`} className="flex gap-2 rounded-xl bg-muted/60 p-3 text-sm">
              <CircleHelp className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span>
                <span className="font-medium">{f.title} — not verified.</span>{" "}
                {f.expected && <span>Expected: {f.expected}. </span>}
                <span className="text-muted-foreground">{f.explanation}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {passed.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Show passed checks</summary>
          <ul className="mt-2 space-y-1.5">
            {passed.map((f, i) => (
              <li key={`${f.ruleId}-${f.fileId ?? ""}-${i}`} className="flex gap-2">
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-pass" aria-hidden />
                <span>
                  {f.title}: {f.detected}
                  {f.fileName && <span className="text-muted-foreground"> · {f.fileName}</span>}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
