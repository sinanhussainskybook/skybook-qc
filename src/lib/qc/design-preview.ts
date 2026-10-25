import type { QcFile } from "@/lib/db/qc-sessions";
import type { BucketClient } from "@/lib/storage/storage-api";

/**
 * The checked design, shown beside the QC result so a designer can compare each fix with the artwork.
 *
 * Each design file gets a short-lived private link (the bucket stays private; the link expires on its
 * own). Only images the browser can show get one — PDFs and videos are listed by name. Like the Home
 * page's logos, the lookup has a short deadline of its own, so a slow or failing Storage never holds up
 * the result: a file whose link isn't ready in time is shown by name instead. Nothing is stored.
 */

export const DESIGN_PREVIEW_SECONDS = 600;
export const DESIGN_PREVIEW_TIMEOUT_MS = 2_000;
const SHOWN_IN_BROWSER = new Set(["image/png", "image/jpeg", "image/webp"]);

export type DesignPreview = {
  id: string;
  fileName: string;
  /** A short-lived link to the image, or null (not an image, no Storage, or no link in time). */
  url: string | null;
  width: number | null;
  height: number | null;
};

export async function designPreviews(
  storage: Pick<BucketClient, "signedUrl"> | null,
  files: Pick<QcFile, "id" | "kind" | "file_name" | "storage_path" | "mime_type" | "media_width" | "media_height">[],
  timeoutMs: number = DESIGN_PREVIEW_TIMEOUT_MS
): Promise<DesignPreview[]> {
  const designs = files.filter((f) => f.kind === "content");
  const urls = new Map<string, string>();

  if (storage) {
    const lookup = Promise.all(
      designs
        .filter((f) => SHOWN_IN_BROWSER.has(f.mime_type))
        .map(async (f) => {
          try {
            urls.set(f.id, await storage.signedUrl(f.storage_path, DESIGN_PREVIEW_SECONDS));
          } catch (error) {
            console.error("Making a design preview link failed:", error);
          }
        })
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), timeoutMs);
    });
    try {
      if ((await Promise.race([lookup, deadline])) === "late") {
        console.error(`Design preview links took longer than ${timeoutMs} ms; showing file names instead.`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // Read once the deadline has passed: a link that arrives later is ignored.
  const ready = new Map(urls);
  return designs.map((f) => ({
    id: f.id,
    fileName: f.file_name,
    url: ready.get(f.id) ?? null,
    width: f.media_width,
    height: f.media_height,
  }));
}
