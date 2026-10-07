import sharp from "sharp";
import type { ReportLogo } from "@/lib/report/report-pdf";

/**
 * The company logo for the report: whatever was saved (PNG, JPG, WebP or SVG,
 * up to 2 MB) turned into a small PNG the PDF can embed. A missing, damaged
 * or unreadable logo gives null — the report then shows the name only.
 */
export async function logoForReport(bytes: Uint8Array | null): Promise<ReportLogo> {
  if (!bytes?.length) return null;
  try {
    const png = await sharp(bytes, { limitInputPixels: 40_000_000 })
      .resize(600, 200, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .png()
      .toBuffer();
    return { bytes: new Uint8Array(png), mime: "image/png" };
  } catch {
    return null;
  }
}
