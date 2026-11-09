import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { prepareImage } from "@/lib/analysis/media/images";
import { LocalMediaPreparer } from "@/lib/analysis/media/local";
import { ANALYSIS_LIMITS, GEMINI_LIMITS, LOCAL_LIMITS } from "@/lib/analysis/limits";

/**
 * Stage 1 (speed): images are decoded and resized once (the encoders are unchanged), and a
 * one-call provider (Gemini) gets a single image per design. Same pixels, same files as before.
 */

/** A photo-like image (smooth noise) — large as PNG, so it exercises the JPEG fallback. */
async function photo(width: number, height: number): Promise<Uint8Array> {
  const noise = Buffer.alloc(width * height * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24; // deterministic "random"
  return new Uint8Array(await sharp(noise, { raw: { width, height, channels: 3 } }).blur(1.2).png().toBuffer());
}
/** A flat graphic with text-like detail. */
async function graphic(width: number, height: number): Promise<Uint8Array> {
  const lines = Array.from({ length: 12 }, (_, i) => `<rect x="40" y="${60 + i * 50}" width="${300 + i * 20}" height="18" fill="#ffffff"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#0e6377"/><circle cx="${width * 0.7}" cy="${height * 0.4}" r="${width * 0.2}" fill="#f26a1b"/>${lines}</svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
}
/** The pixels the old pipeline produced: upright, resized, flattened on white. */
const expectedPixels = (bytes: Uint8Array, longEdge: number) =>
  sharp(bytes).rotate().resize({ width: longEdge, height: longEdge, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).raw().toBuffer();
const decoded = (bytes: Uint8Array) => sharp(bytes).removeAlpha().raw().toBuffer();

describe("prepareImage", () => {
  it("PNG: exactly the same pixels as before (lossless), at the same size", async () => {
    const source = await graphic(3000, 1500);
    const prepared = await prepareImage(source, "k", 2048, "design.png");
    expect(prepared).toMatchObject({ key: "k", mime: "image/png", width: 2048, height: 1024, sourceName: "design.png" });
    expect(Buffer.compare(await decoded(prepared.bytes), await expectedPixels(source, 2048))).toBe(0);
  });

  it("never enlarges a small design, and keeps it lossless", async () => {
    const source = await graphic(800, 600);
    const prepared = await prepareImage(source, "k", 2048);
    expect(prepared).toMatchObject({ mime: "image/png", width: 800, height: 600 });
    expect(Buffer.compare(await decoded(prepared.bytes), await expectedPixels(source, 2048))).toBe(0);
  });

  it("byte for byte what the old pipeline sent — PNG, and the JPEG fallback (the encoders and settings are unchanged)", async () => {
    const old = async (bytes: Uint8Array, longEdge: number, maxBytes: number) => {
      const base = sharp(bytes).rotate().resize({ width: longEdge, height: longEdge, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" });
      const png = await base.clone().png({ compressionLevel: 9 }).toBuffer();
      if (png.length <= maxBytes) return { mime: "image/png", bytes: png };
      for (const quality of [92, 85, 75, 60]) {
        const jpeg = await base.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
        if (jpeg.length <= maxBytes || quality === 60) return { mime: "image/jpeg", bytes: jpeg };
      }
      throw new Error("unreachable");
    };
    const source = await photo(1600, 1200);
    const pngSize = (await old(source, 2048, Infinity)).bytes.length;
    for (const maxBytes of [Infinity, pngSize - 1]) {
      const before = await old(source, 2048, maxBytes);
      const now = await prepareImage(source, "k", 2048, undefined, maxBytes);
      expect(now.mime).toBe(before.mime);
      expect(Buffer.compare(Buffer.from(now.bytes), before.bytes)).toBe(0);
    }
  });

  it("too large for PNG: JPEG at the highest quality that fits, same size; nothing fits → an error", async () => {
    const source = await photo(1600, 1600);
    const pngSize = (await sharp(source).png({ compressionLevel: 9 }).toBuffer()).length;
    const prepared = await prepareImage(source, "k", 2048, undefined, pngSize - 1);
    expect(prepared).toMatchObject({ mime: "image/jpeg", width: 1600, height: 1600 });
    expect(prepared.bytes.length).toBeLessThan(pngSize);
    await expect(prepareImage(source, "k", 2048, undefined, 1_000)).rejects.toThrow("too large");
  });
});

describe("one image per design for a one-call provider", () => {
  const signal = new AbortController().signal;
  const file = { id: "f1", fileName: "design.png", mimeType: "image/png", width: 3000, height: 1500, durationMs: null, pages: null };

  it("Gemini: the judge image is also the OCR image and the colour source; the full-size OCR image is made only on request", async () => {
    expect(GEMINI_LIMITS.separateOcrImage).toBe(false);
    const prepared = await new LocalMediaPreparer(GEMINI_LIMITS).prepareContent(file, await graphic(3000, 1500), "", signal);
    const [frame] = prepared.frames;
    expect(frame.judgeImage).toMatchObject({ width: 2048, height: 1024 });
    expect(frame.ocrImage).toBe(frame.judgeImage);
    expect(frame.prepareOcrImage).toBeTypeOf("function");
    const full = await frame.prepareOcrImage!();
    expect(full).toMatchObject({ width: 3000, height: 1500 }); // up to the 4096 OCR size, never enlarged
    const colours = await frame.measureColours!([]);
    expect(colours.dominant[0].hex).toBe("#0E6377");
  });

  it("other providers keep a separate full-size OCR image, as before", async () => {
    for (const limits of [ANALYSIS_LIMITS, LOCAL_LIMITS.cpu]) {
      expect(limits.separateOcrImage).toBe(true);
      const [frame] = (await new LocalMediaPreparer(limits).prepareContent(file, await graphic(3000, 1500), "", signal)).frames;
      expect(frame.ocrImage).not.toBe(frame.judgeImage);
      expect(frame.ocrImage).toMatchObject({ width: 3000, height: 1500 });
      expect(frame.prepareOcrImage).toBeUndefined();
    }
  });
});
