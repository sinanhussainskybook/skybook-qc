import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One step of the check page: a large number, a bold title and one short
 * line, then the step's single action. Steps are separated by hairlines —
 * no cards or icons — so the page reads top to bottom: brief, design, check.
 */
export function Step({
  id,
  n,
  title,
  description,
  children,
  className,
  compact = false,
}: {
  id: string;
  /** The step number; omitted for an optional step (e.g. Platform). */
  n?: number;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Smaller, for the side pane next to the QC result. */
  compact?: boolean;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn(
        "grid scroll-mt-24 border-t border-border",
        compact ? "grid-cols-[1.75rem_1fr] gap-x-3 gap-y-2 py-5" : "gap-x-8 gap-y-4 py-8 sm:grid-cols-[3.5rem_1fr] sm:py-10",
        className
      )}
    >
      <span className={cn("display tabular-nums", compact ? "text-2xl" : "text-4xl sm:text-5xl", n ? "text-primary" : "text-border")} aria-hidden>
        {n ?? "·"}
      </span>
      <div className="min-w-0">
        <h2 id={`${id}-title`} className={cn("font-semibold tracking-tight", compact ? "text-base" : "text-xl sm:text-2xl")}>
          {n ? <span className="sr-only">{n}. </span> : null}
          {title}
        </h2>
        {description && <p className={cn("mt-1 max-w-2xl text-muted-foreground", compact ? "text-xs" : "text-sm")}>{description}</p>}
        <div className={compact ? "mt-3" : "mt-5"}>{children}</div>
      </div>
    </section>
  );
}
