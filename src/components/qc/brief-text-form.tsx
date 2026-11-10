"use client";

import { useActionState, useId, useState } from "react";
import { PenLine } from "lucide-react";
import { saveBriefTextAction, type QcFormState } from "@/lib/qc/actions";
import { BRIEF_TEXT_MAX_CHARS, BRIEF_TEXT_MESSAGES, checkBriefText } from "@/lib/qc/brief-text";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Enter brief text — the second way to give the brief, next to Upload brief. The designer types or pastes
 * the client's requirements; Save brief text checks it here (empty, too long) and again on the server, which
 * saves it as a plain-text brief file. It then shows in the file list above (removable like any upload) and
 * is read by the same brief reading, together with any uploaded brief.
 *
 * `maxChars` is how long a typed brief may be on this server: 20,000, or less when the AI reads less of
 * a brief (Local AI: 12,000) — longer text is refused with the reason, never saved and cut short. Text
 * over the limit (however much was pasted) is never sent: the count turns red, the reason shows at once
 * and Save is off.
 */
export function BriefTextForm({
  sessionId,
  disabled,
  full,
  maxChars = BRIEF_TEXT_MAX_CHARS,
}: {
  sessionId: string;
  disabled: boolean;
  full: boolean;
  maxChars?: number;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  // What the designer sees: the browser's own check, the server's answer, or the saved message.
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [, formAction, saving] = useActionState(async (previous: QcFormState, formData: FormData) => {
    // The request itself failing (the connection, or a body too large to send) — never a vague "try again".
    const result: QcFormState = await saveBriefTextAction(previous, formData).catch(() => {
      const checked = checkBriefText(formData.get("briefText"), maxChars);
      return { error: checked.ok ? BRIEF_TEXT_MESSAGES.notSent : checked.error };
    });
    if (result.ok) {
      setText("");
      setOpen(false);
      setSaved(result.message ?? "Brief text saved.");
    } else {
      setError(result.error ?? BRIEF_TEXT_MESSAGES.notSent);
    }
    return result;
  }, {});
  const id = useId();
  const length = text.length;
  // Over the limit: the reason at once (checked only past the limit, so typing stays light).
  const overCheck = length > maxChars ? checkBriefText(text, maxChars) : null;
  const overMessage = overCheck && !overCheck.ok ? overCheck.error : null;
  const over = overMessage !== null;
  const shown = error ?? overMessage;

  if (!open) {
    return (
      <div className="space-y-3">
        {saved && (
          <p role="status" className="text-sm font-medium text-pass">
            {saved}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => {
              setOpen(true);
              setError(null);
              setSaved(null);
            }}
            disabled={disabled || full}
            className={cn(
              buttonVariants({ variant: "outline" }),
              "btn-white h-11 cursor-pointer rounded-full px-5 text-sm font-semibold hover:border-primary/40 hover:text-primary",
              (disabled || full) && "pointer-events-none opacity-50"
            )}
          >
            <PenLine aria-hidden />
            Enter brief text
          </button>
          <span className="text-xs text-muted-foreground">Type or paste the client&apos;s requirements</span>
        </div>
      </div>
    );
  }

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        const checked = checkBriefText(text, maxChars);
        if (!checked.ok) {
          event.preventDefault();
          setError(checked.error);
          return;
        }
        setError(null);
      }}
      className="space-y-3 text-left"
    >
      <input type="hidden" name="sessionId" value={sessionId} />
      <label htmlFor={`${id}-text`} className="block text-sm font-semibold">
        Brief text
      </label>
      <textarea
        id={`${id}-text`}
        name="briefText"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          if (error) setError(null);
        }}
        rows={8}
        autoFocus
        disabled={saving}
        aria-invalid={Boolean(shown)}
        aria-describedby={`${id}-count${shown ? ` ${id}-error` : ""}`}
        placeholder={"e.g. Size 1080 × 1080. Headline: Summer Sale — 20% off. Call 0123 456 789. Website www.example.com."}
        className="block w-full resize-y rounded-xl border border-border bg-background px-4 py-3 text-sm leading-relaxed shadow-xs outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-fail disabled:opacity-60"
      />
      <p id={`${id}-count`} className={cn("text-right text-xs tabular-nums", over ? "font-medium text-fail" : "text-muted-foreground")}>
        {length.toLocaleString("en-GB")} / {maxChars.toLocaleString("en-GB")} characters
      </p>
      {shown && (
        <p id={`${id}-error`} role="alert" className="text-sm font-medium text-fail">
          {shown}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={saving || over} className="h-11 rounded-full px-5 text-sm font-semibold">
          {saving ? "Saving…" : "Save brief text"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={saving}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="h-11 rounded-full px-4 text-sm"
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
