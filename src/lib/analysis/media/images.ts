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

/**
 * Upright, at most `longEdge` px, PNG when it fits the byte limit, else JPEG at falling quality.
 *
 * The original is decoded, turned upright, resized and flattened ONCE; every encoding attempt (PNG, then
 * JPEG 92 → 60) starts from those pixels — each attempt used to decode and resize the original again.
 * The encoders and their settings are unchanged, so the result is byte for byte what it was.
 */
export async function prepareImage(
  bytes: Uint8Array,
  key: string,
  longEdge: number,
  sourceName?: string,
  maxBytes: number = ANALYSIS_LIMITS.maxProviderImageBytes
): Promise<PreparedImage> {
  const { data, info } = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
    .rotate()
    .resize({ width: longEdge, height: longEdge, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixels = () => sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
  const result = (mime: PreparedImage["mime"], encoded: Buffer): PreparedImage => ({
    key,
    mime,
    bytes: new Uint8Array(encoded),
    width: info.width,
    height: info.height,
    sourceName,
  });

  const png = await pixels().png({ compressionLevel: 9 }).toBuffer();
  if (png.length <= maxBytes) return result("image/png", png);
  for (const quality of [92, 85, 75, 60]) {
    const jpeg = await pixels().jpeg({ quality, mozjpeg: true }).toBuffer();
    if (jpeg.length <= maxBytes || quality === 60) {
      if (jpeg.length > maxBytes) throw new Error("image too large to send even after compression");
      return result("image/jpeg", jpeg);
    }
  }
  throw new Error("unreachable");
}
