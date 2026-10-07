import sharp from "sharp";
import type { MeasuredColours } from "@/lib/analysis/assemble";
import type { OcrBlock } from "@/lib/analysis/validate";

/**
 * MEASURED colours from pixels (no AI): the frame's dominant colours, and
 * for each OCR text block the text colour and the colour behind it (the two
 * colour groups inside the block's box — the larger group is the
 * background). Used by contrast and brand-colour checks.
 */

const SAMPLE_LONG_EDGE = 1024;

const hex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;

type Raw = { data: Buffer; width: number; height: number };

export async function rawPixels(image: Uint8Array): Promise<Raw> {
  const { data, info } = await sharp(image)
    .removeAlpha()
    .resize({ width: SAMPLE_LONG_EDGE, height: SAMPLE_LONG_EDGE, fit: "inside", withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** The most common colours (4 bits per channel buckets), largest share first. */
export function dominantColours(raw: Raw, limit = 8): { hex: string; share: number }[] {
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  const total = raw.width * raw.height;
  for (let i = 0; i < raw.data.length; i += 3) {
    const r = raw.data[i];
    const g = raw.data[i + 1];
    const b = raw.data[i + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bin.n++;
    bin.r += r;
    bin.g += g;
    bin.b += b;
    bins.set(key, bin);
  }
  return [...bins.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, limit)
    .map((bin) => ({ hex: hex(bin.r / bin.n, bin.g / bin.n, bin.b / bin.n), share: Math.round((bin.n / total) * 1000) / 1000 }));
}

const MAX_SAMPLE = 20_000;

const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Text and background colour inside a box: two-means on brightness, then the mean colour of each group. */
export function textColours(raw: Raw, box: NonNullable<OcrBlock["box"]>): { color: string; background: string } | null {
  const x0 = Math.max(0, Math.floor(box.x * raw.width));
  const y0 = Math.max(0, Math.floor(box.y * raw.height));
  const x1 = Math.min(raw.width, Math.ceil((box.x + box.w) * raw.width));
  const y1 = Math.min(raw.height, Math.ceil((box.y + box.h) * raw.height));
  // Evenly spaced sample of at most ~20k pixels (large headlines stay fast and bounded).
  const stride = Math.max(1, Math.ceil(Math.sqrt(((x1 - x0) * (y1 - y0)) / MAX_SAMPLE)));
  const pixels: [number, number, number, number][] = [];
  for (let y = y0; y < y1; y += stride) {
    for (let x = x0; x < x1; x += stride) {
      const i = (y * raw.width + x) * 3;
      const r = raw.data[i];
      const g = raw.data[i + 1];
      const b = raw.data[i + 2];
      pixels.push([r, g, b, luminance(r, g, b)]);
    }
  }
  if (pixels.length < 8) return null;
  // Plain loops: spreading a large array into Math.min/max overflows the stack.
  let low = Infinity;
  let high = -Infinity;
  for (const p of pixels) {
    if (p[3] < low) low = p[3];
    if (p[3] > high) high = p[3];
  }
  if (high - low < 1) return null; // a flat box: no text visible at this size
  let groups: [number, number, number, number][][] = [[], []];
  for (let iteration = 0; iteration < 6; iteration++) {
    groups = [[], []];
    for (const p of pixels) groups[Math.abs(p[3] - low) <= Math.abs(p[3] - high) ? 0 : 1].push(p);
    if (!groups[0].length || !groups[1].length) return null;
    low = groups[0].reduce((s, p) => s + p[3], 0) / groups[0].length;
    high = groups[1].reduce((s, p) => s + p[3], 0) / groups[1].length;
  }
  const mean = (g: [number, number, number, number][]) => hex(...([0, 1, 2].map((c) => g.reduce((s, p) => s + p[c], 0) / g.length) as [number, number, number]));
  const [small, large] = groups[0].length < groups[1].length ? [groups[0], groups[1]] : [groups[1], groups[0]];
  return { color: mean(small), background: mean(large) };
}

/** The measureColours function for one prepared image. */
export function colourSampler(image: Uint8Array): (blocks: OcrBlock[]) => Promise<MeasuredColours> {
  return async (blocks) => {
    const raw = await rawPixels(image);
    const byBlock: MeasuredColours["byBlock"] = {};
    for (const block of blocks) {
      if (!block.box) continue; // no position, so no colours to measure
      const found = textColours(raw, block.box);
      if (found) byBlock[block.id] = found;
    }
    return { byBlock, dominant: dominantColours(raw) };
  };
}
