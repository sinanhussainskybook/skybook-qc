import { ShieldAlert } from "lucide-react";

export const GEMINI_FREE_TIER_TITLE = "Gemini free tier — check what you upload.";
export const GEMINI_FREE_TIER_TEXT =
  "Designs and information files you analyse here are sent to Google's Gemini API, together with your confirmed requirements and this company's brand rules. On the free tier, Google may use what is sent to improve its products, and human reviewers may read it. Don't upload confidential client material. Gemini has no EU data region.";

/**
 * Shown on Start QC above the first upload step, only when the configured
 * analysis provider is Gemini (free tier — see docs/GEMINI.md, Limitations),
 * so designers see it before any file can be sent to Google.
 */
export function GeminiFreeTierNotice() {
  return (
    <aside
      role="note"
      aria-label="Gemini free tier privacy notice"
      className="mb-2 flex gap-3 rounded-2xl border border-revision/25 bg-revision-soft/60 px-4 py-3 text-xs leading-relaxed text-foreground/80"
    >
      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-revision" aria-hidden />
      <div className="min-w-0">
        <p className="font-semibold text-revision">{GEMINI_FREE_TIER_TITLE}</p>
        <p>{GEMINI_FREE_TIER_TEXT}</p>
      </div>
    </aside>
  );
}
