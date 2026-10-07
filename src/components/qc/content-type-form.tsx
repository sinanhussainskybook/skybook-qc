"use client";

import { useActionState, useState } from "react";
import { Clapperboard, Image as ImageIcon, LayoutTemplate, MonitorPlay } from "lucide-react";
import { changeContentTypeAction, startSessionAction, type QcFormState } from "@/lib/qc/actions";
import { OFFERED_CONTENT_TYPES, type ContentType } from "@/lib/qc/content-types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const ICONS: Record<ContentType, typeof ImageIcon> = {
  design_poster: LayoutTemplate,
  social_post: ImageIcon,
  reel_short: Clapperboard,
  youtube_video: MonitorPlay,
};

const HINTS: Record<ContentType, string> = {
  design_poster: "Images or PDF",
  social_post: "Images or PDF",
  reel_short: "MP4, MOV or WEBM",
  youtube_video: "MP4, MOV or WEBM",
};

/**
 * Choose what's being checked. Used to start a session (mode "start") and
 * to change it later (mode "change", with the current session's ID). Only
 * the offered (static design) types are shown; video types are kept for later.
 */
export function ContentTypeForm({
  mode,
  companyId,
  sessionId,
  current,
}: {
  mode: "start" | "change";
  companyId: string;
  sessionId?: string;
  current?: ContentType;
}) {
  const [picked, setPicked] = useState<ContentType | null>(current ?? null);
  const [state, formAction, pending] = useActionState<QcFormState, FormData>(
    mode === "start" ? startSessionAction : changeContentTypeAction,
    {}
  );
  const changed = picked !== null && picked !== current;

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="companyId" value={companyId} />
      {sessionId && <input type="hidden" name="sessionId" value={sessionId} />}

      <fieldset>
        <legend className="sr-only">What are you checking?</legend>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {OFFERED_CONTENT_TYPES.map((type) => {
            const Icon = ICONS[type.value];
            const selected = picked === type.value;
            return (
              <label
                key={type.value}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-xl bg-card p-3.5 ring-1 ring-border transition-colors has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
                  selected ? "bg-secondary ring-2 ring-primary" : "hover:bg-muted/60"
                )}
              >
                <input
                  type="radio"
                  name="contentType"
                  value={type.value}
                  checked={selected}
                  onChange={() => setPicked(type.value)}
                  className="sr-only"
                />
                <span
                  className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-lg",
                    selected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                  )}
                >
                  <Icon className="size-4.5" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{type.label}</span>
                  <span className="block text-xs text-muted-foreground">{HINTS[type.value]}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {state.error && (
        <p role="alert" className="text-sm font-medium text-fail">
          {state.error}
        </p>
      )}

      {(mode === "start" || changed) && (
        <Button
          type="submit"
          disabled={!picked || pending}
          className="h-10 rounded-full bg-foreground px-5 text-sm font-semibold text-background hover:bg-foreground/85"
        >
          {pending ? "Saving…" : mode === "start" ? "Start QC" : "Change content type"}
        </Button>
      )}
    </form>
  );
}
