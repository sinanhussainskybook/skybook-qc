"use client";

import { useState } from "react";
import Image from "next/image";
import { FileImage } from "lucide-react";
import type { DesignPreview } from "@/lib/qc/design-preview";

/**
 * The checked design beside the QC result: each image as it was uploaded, opening full size in a new
 * tab; a PDF, a video, or an image whose link didn't load (expired, or Storage didn't answer) shows its
 * file name instead.
 */
export function DesignPreviews({ previews }: { previews: DesignPreview[] }) {
  if (previews.length === 0) return null;
  return (
    <ul aria-label="Checked design" className="grid gap-3">
      {previews.map((preview) => (
        <li key={preview.id}>
          <DesignImage preview={preview} />
        </li>
      ))}
    </ul>
  );
}

function DesignImage({ preview }: { preview: DesignPreview }) {
  const [failed, setFailed] = useState(false);
  const ratio = preview.width && preview.height ? `${preview.width} / ${preview.height}` : "4 / 5";

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
        className="relative block max-h-[70dvh] w-full overflow-hidden rounded-xl bg-card ring-1 ring-border transition-shadow hover:ring-primary/50"
        style={{ aspectRatio: ratio }}
        aria-label={`Open ${preview.fileName} full size`}
      >
        <Image src={preview.url} alt={`The checked design: ${preview.fileName}`} fill unoptimized sizes="22rem" className="object-contain" onError={() => setFailed(true)} />
      </a>
      <figcaption className="mt-1.5 truncate text-xs text-muted-foreground">{preview.fileName}</figcaption>
    </figure>
  );
}
