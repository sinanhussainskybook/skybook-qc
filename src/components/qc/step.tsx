import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One step of the check page: the title with its number in front ("2. Upload design"), one short line,
 * then the step's action — all centred, steps separated by hairlines (no cards or icons), so the page
 * reads top to bottom: brief, design, check. Uploaded files and forms inside keep their own left-aligned
 * text; each button sits exactly in the centre, with its note (file types, Start over) underneath.
 *
 * `compact` (the side pane next to the QC result) keeps the small left-aligned layout, with the number
 * in its own column.
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
  if (compact) {
    return (
      <section id={id} aria-labelledby={`${id}-title`} className={cn("grid scroll-mt-24 grid-cols-[1.75rem_1fr] gap-x-3 gap-y-2 border-t border-border py-5", className)}>
        <span className={cn("display text-2xl tabular-nums", n ? "text-primary" : "text-border")} aria-hidden>
          {n ?? "·"}
        </span>
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="text-base font-semibold tracking-tight">
            {n ? <span className="sr-only">{n}. </span> : null}
            {title}
          </h2>
          {description && <p className="mt-1 max-w-2xl text-xs text-muted-foreground">{description}</p>}
          <div className="mt-3">{children}</div>
        </div>
      </section>
    );
  }

  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn("scroll-mt-24 border-t border-border py-8 text-center sm:py-10", className)}>
      <h2 id={`${id}-title`} className="text-2xl font-semibold tracking-tight sm:text-3xl">
        {n ? <span className="text-primary tabular-nums">{n}. </span> : null}
        {title}
      </h2>
      {description && <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">{description}</p>}
      <div className="mx-auto mt-5 w-full max-w-2xl [&_.flex-wrap]:justify-center [&_.flex-wrap.gap-3]:flex-col [&_form]:text-left [&_li.flex]:text-left">{children}</div>
    </section>
  );
}
