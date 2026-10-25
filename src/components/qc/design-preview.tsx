"use client";

import { useState } from "react";
import Image from "next/image";
import { FileImage } from "lucide-react";
import type { DesignPreview } from "@/lib/qc/design-preview";
import type { IssueMarker } from "@/lib/qc/issue-markers";
import type { Severity } from "@/lib/qc/findings";
import { cn } from "@/lib/utils";

const MARKER_STYLE: Record<Severity, { ring: string; badge: string }> = {
  critical: { ring: "border-fail", badge: "bg-fail" },
  major: { ring: "border-revision", badge: "bg-revision" },
  minor: { ring: "border-primary", badge: "bg-primary" },
  suggestion: { ring: "border-muted-foreground", badge: "bg-muted-foreground" },
};

/**
 * The checked design beside the QC result: each image as it was uploaded, opening full size in a new
 * tab, with each issue to fix circled where its text was read, numbered as in "Issues to fix" (positions
 * are approximate). A PDF, a video, or an image whose link didn't load (expired, or Storage didn't
 * answer) shows its file name instead.
 */
export function DesignPreviews({ previews, markers = [] }: { previews: DesignPreview[]; markers?: IssueMarker[] }) {
  if (previews.length === 0) return null;
  return (
    <ul aria-label="Checked design" className="grid gap-3">
      {previews.map((preview) => (
        <li key={preview.id}>
          <DesignImage preview={preview} markers={markers.filter((m) => m.fileId === preview.id)} />
        </li>
      ))}
    </ul>
  );
}

function DesignImage({ preview, markers }: { preview: DesignPreview; markers: IssueMarker[] }) {
  const [failed, setFailed] = useState(false);
  // Circles are placed by fractions of the image, so only when its real proportions are known.
  const sized = Boolean(preview.width && preview.height);
  const ratio = sized ? `${preview.width} / ${preview.height}` : "4 / 5";

  if (!preview.url || failed) {
    return (
      <p className="flex items-center gap-2 rounded-xl bg-card px-3 py-3 text-sm ring-1 ring-border">
        <FileImage className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate font-medium">{preview.fileName}</span>
      </p>
    );
  }
  return (
    <figure className="m-0">
      <a
        href={preview.url}
        target="_blank"
        rel="noreferrer"
        className="relative block w-full overflow-hidden rounded-xl bg-card ring-1 ring-border transition-shadow hover:ring-primary/50"
        style={{ aspectRatio: ratio }}
        aria-label={`Open ${preview.fileName} full size`}
      >
        <Image src={preview.url} alt={`The checked design: ${preview.fileName}`} fill unoptimized sizes="22rem" className="object-contain" onError={() => setFailed(true)} />
        {sized &&
          markers.map((m) => (
            <span
              key={m.n}
              aria-hidden
              className={cn("pointer-events-none absolute rounded-[50%] border-2 shadow-[0_0_0_2px_rgb(255_255_255/0.7)]", MARKER_STYLE[m.severity].ring)}
              style={{ left: `calc(${m.box.x * 100}% - 6px)`, top: `calc(${m.box.y * 100}% - 6px)`, width: `calc(${m.box.w * 100}% + 12px)`, height: `calc(${m.box.h * 100}% + 12px)` }}
            >
              <span className={cn("absolute -top-2.5 -left-2.5 flex size-5 items-center justify-center rounded-full text-[11px] font-bold text-white ring-2 ring-white", MARKER_STYLE[m.severity].badge)}>
                {m.n}
              </span>
            </span>
          ))}
      </a>
      <figcaption className="mt-1.5 text-xs text-muted-foreground">
        <span className="block truncate">{preview.fileName}</span>
        {sized && markers.length > 0 && (
          <span className="block">Numbers match &ldquo;Issues to fix&rdquo;; circles show roughly where each was found.</span>
        )}
      </figcaption>
    </figure>
  );
}
