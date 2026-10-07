import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A rounded white card for one section of the company page. */
export function SectionCard({
  id,
  title,
  description,
  icon: Icon,
  action,
  children,
  className,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn(
        "scroll-mt-24 rounded-2xl bg-card p-5 ring-1 ring-foreground/8 sm:p-7",
        className
      )}
    >
      <div className="flex items-start gap-3">
        {Icon && (
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
            <Icon className="size-4.5" aria-hidden />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h2 id={`${id}-title`} className="text-lg font-semibold tracking-tight">
            {title}
          </h2>
          {description && (
            <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {action}
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

/** A smaller heading inside a section (e.g. "Colours" inside Brand guidelines). */
export function SubSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="border-t border-border pt-5 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-semibold">{title}</h3>
      {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      <div className="mt-3">{children}</div>
    </div>
  );
}
