import sharp from "sharp";
import { ANALYSIS_LIMITS } from "@/lib/analysis/limits";
import type { PreparedImage } from "@/lib/analysis/provider";

/**
 * Re-encoding images for providers (D5): orientation applied (EXIF), size
 * reduced to a long edge, and encoded below the inline limit (~7 MB for both
 * Vision and Gemini). The original upload is never changed.
 */

/** sharp refuses decompression bombs above this many pixels. */
export const MAX_INPUT_PIXELS = 120_000_000;

export async function orientedSize(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  const meta = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).rotate().metadata();
  // .metadata() reports the stored size; for EXIF orientations 5–8 the image is shown rotated.
  const swap = (meta.orientation ?? 1) >= 5;
  const width = (swap ? meta.height : meta.width) ?? 0;
  const height = (swap ? meta.width : meta.height) ?? 0;
  return { width, height };
}

/** Upright, at most `longEdge` px, PNG when it fits the byte limit, else JPEG at falling quality. */
export async function prepareImage(
  bytes: Uint8Array,
  key: string,
  longEdge: number,
  sourceName?: string,
  maxBytes: number = ANALYSIS_LIMITS.maxProviderImageBytes
): Promise<PreparedImage> {
  const base = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
    .rotate()
    .resize({ width: longEdge, height: longEdge, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" });
  const png = await base.clone().png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
  if (png.data.length <= maxBytes) {
    return { key, mime: "image/png", bytes: new Uint8Array(png.data), width: png.info.width, height: png.info.height, sourceName };
  }
  for (const quality of [92, 85, 75, 60]) {
    const jpeg = await base.clone().jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    if (jpeg.data.length <= maxBytes || quality === 60) {
      if (jpeg.data.length > maxBytes) throw new Error("image too large to send even after compression");
      return { key, mime: "image/jpeg", bytes: new Uint8Array(jpeg.data), width: jpeg.info.width, height: jpeg.info.height, sourceName };
    }
  }
  throw new Error("unreachable");
}
