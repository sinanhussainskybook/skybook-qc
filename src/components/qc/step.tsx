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
}: {
  id: string;
  /** The step number; omitted for an optional step (e.g. Platform). */
  n?: number;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn("grid scroll-mt-24 gap-x-8 gap-y-4 border-t border-border py-8 sm:grid-cols-[3.5rem_1fr] sm:py-10", className)}>
      <span className={cn("display text-4xl tabular-nums sm:text-5xl", n ? "text-primary" : "text-border")} aria-hidden>
        {n ?? "·"}
      </span>
      <div className="min-w-0">
        <h2 id={`${id}-title`} className="text-xl font-semibold tracking-tight sm:text-2xl">
          {n ? <span className="sr-only">{n}. </span> : null}
          {title}
        </h2>
        {description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>}
        <div className="mt-5">{children}</div>
      </div>
    </section>
  );
}
