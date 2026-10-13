import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CATEGORIES, severityLabel, type Category, type Finding } from "@/lib/qc/findings";
import { isHumanCheck } from "@/lib/analysis/policy";
import { notAnalysedExplanation, type AnalysisState } from "@/lib/qc/rules/context";
import { cn } from "@/lib/utils";

const HUMAN = { label: "Needs a human check", className: "bg-revision-soft text-revision" };
const STATUS: Record<Finding["status"], { label: string; className: string }> = {
  failed: { label: "To fix", className: "bg-fail-soft text-fail" },
  unverified: { label: "Not verified", className: "bg-muted text-muted-foreground" },
  passed: { label: "Passed", className: "bg-pass-soft text-pass" },
  not_applicable: { label: "Not applicable", className: "bg-muted text-muted-foreground" },
};

/**
 * Every category except Platform / Size (shown in its own section): what is
 * checked and what the result is. Checks the analysis couldn't support are
 * "not verified" — the reason said once, plainly, never guessed — and
 * uncertain readings are "Needs a human check". The score and PASS / NEEDS
 * REVISION / FAIL are in the QC result section (scoreboard.tsx).
 */
export const LOCAL_NOTICE =
  "Checked by Local AI on this server. Its judgements aren't confirmed: where it saw no problem the check stays not verified, and anything that could fail the design needs a human check.";

export const GEMINI_NOTICE =
  "Read by Gemini (AI): the text, its position and the design judgements come from the AI, not a measurement. Anything that could fail the design needs a human check, and where Gemini saw no problem the check stays not verified.";

export function CategoryChecks({ findings, analysis, mock = false, local = false, gemini = false }: { findings: Finding[]; analysis?: AnalysisState; mock?: boolean; local?: boolean; gemini?: boolean }) {
  const categories = CATEGORIES.filter((c) => c.value !== "platform_size");
  const note = notAnalysedExplanation(analysis);
  const waiting = findings.filter((f) => f.explanation === note).length;
  const human = findings.filter(isHumanCheck).length;

  return (
    <div className="space-y-3">
      {mock && (
        <p className="rounded-xl bg-revision-soft px-4 py-3 text-sm font-medium text-revision">
          Sample data — not real AI. These results come from the test provider and say nothing about the real content.
        </p>
      )}
      {local && <p className="rounded-xl bg-muted/60 px-4 py-3 text-sm text-muted-foreground">{LOCAL_NOTICE}</p>}
      {gemini && <p className="rounded-xl bg-muted/60 px-4 py-3 text-sm text-muted-foreground">{GEMINI_NOTICE}</p>}
      {waiting > 0 && (
        <p className="rounded-xl bg-muted/60 px-4 py-3 text-sm text-muted-foreground">
          {waiting} check{waiting === 1 ? "" : "s"} not verified: {note}
        </p>
      )}
      {human > 0 && (
        <p className="rounded-xl bg-revision-soft px-4 py-3 text-sm text-foreground">
          {human} finding{human === 1 ? "" : "s"} <strong>to verify</strong> — the AI wasn&apos;t sure enough for {human === 1 ? "it" : "them"} to
          count. Please check {human === 1 ? "it" : "them"} by eye before sending the content.
        </p>
      )}
      <ul className="divide-y divide-border rounded-xl ring-1 ring-border" aria-label="Checks by category">
        {categories.map(({ value, label }) => (
          <CategoryRow key={value} label={label} note={note} findings={findings.filter((f) => f.category === (value as Category))} />
        ))}
      </ul>
    </div>
  );
}

function CategoryRow({ label, note, findings }: { label: string; note: string; findings: Finding[] }) {
  const humanCount = findings.filter(isHumanCheck).length;
  const count = (status: Finding["status"]) => findings.filter((f) => f.status === status).length - (status === "unverified" ? humanCount : 0);
  return (
    <li>
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 text-sm">
          <span className="min-w-0 flex-1 font-medium">{label}</span>
          {humanCount > 0 && <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", HUMAN.className)}>{humanCount} to check</span>}
          {(["failed", "unverified", "passed", "not_applicable"] as const)
            .filter((s) => count(s) > 0)
            .map((s) => (
              <span key={s} className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", STATUS[s].className)}>
                {count(s)} {STATUS[s].label.toLowerCase()}
              </span>
            ))}
          <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <ul className="space-y-2 px-4 pb-4">
          {findings.map((f, i) => (
            <li key={`${f.ruleId}-${i}`} className="rounded-lg bg-muted/40 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{f.title}</span>
                <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", (isHumanCheck(f) ? HUMAN : STATUS[f.status]).className)}>
                  {(isHumanCheck(f) ? HUMAN : STATUS[f.status]).label}
                </span>
                {f.status === "failed" && <Badge variant="outline">{severityLabel(f.severity)}</Badge>}
              </div>
              {f.expected && <p className="mt-1 text-muted-foreground">Expected: {f.expected}</p>}
              {(f.status === "failed" || isHumanCheck(f)) && f.detected && <p className="mt-1 text-muted-foreground">Detected: {f.detected}</p>}
              {f.explanation !== note && <p className="mt-1">{f.explanation}</p>}
              {f.suggestedFix && <p className="mt-1">Suggested fix: {f.suggestedFix}</p>}
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}
