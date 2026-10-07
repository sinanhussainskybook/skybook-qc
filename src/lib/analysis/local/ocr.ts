import { readFile } from "node:fs/promises";
import type { LocalConfig } from "@/lib/analysis/local/config";
import type { PreparedImage } from "@/lib/analysis/provider";

/**
 * Local text reading (OCR) with PaddleOCR via ONNX Runtime, in the worker
 * process. Models are read from the pinned files in QC_LOCAL_MODELS_DIR and
 * handed over as bytes, so the library never downloads anything.
 *
 * Every line is then read a SECOND time by a different model (PP-OCRv5
 * English) on just that line's crop. Only lines where both reads agree keep
 * their full confidence (validate.ts caps the rest below 0.90), because a
 * single read was confidently wrong twice in the 2026-10-06 trial.
 * The output is the "local-ocr-v1" JSON that validateLocalOcr checks.
 */

export type OcrLine = { text: string; box: { x: number; y: number; w: number; h: number }; confidence: number };

export interface OcrEngine {
  read(image: Uint8Array): Promise<OcrLine[]>;
  destroy(): Promise<void>;
}

/** At most this many lines get a second read per image (the rest stay unconfirmed). */
export const MAX_SECOND_READS = 60;
const CROP_PADDING = 8;

type PpuBox = { x: number; y: number; width: number; height: number };
type PpuItem = { text: string; box: PpuBox; confidence: number };
type PpuService = { initialize(): Promise<void>; recognize(input: ArrayBuffer): Promise<{ lines: PpuItem[][] }>; destroy(): Promise<void> };

const toArrayBuffer = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/** A PaddleOCR model pair (detection + recognition + dictionary) loaded from local files. */
export class PaddleOcrEngine implements OcrEngine {
  private service: PpuService | null = null;
  private loading: Promise<PpuService> | null = null;

  constructor(private readonly files: { detection: string; recognition: string; dictionary: string }) {}

  private async load(): Promise<PpuService> {
    if (this.service) return this.service;
    this.loading ??= (async () => {
      const [detection, recognition, dictionary] = await Promise.all([this.files.detection, this.files.recognition, this.files.dictionary].map((f) => readFile(f)));
      // Loaded at run time from the worker only (never bundled into the web app).
      const ppu = (await import("ppu-paddle-ocr")) as unknown as { PaddleOcrService: new (o: unknown) => PpuService };
      const service = new ppu.PaddleOcrService({
        model: { detection: toArrayBuffer(detection), recognition: toArrayBuffer(recognition), charactersDictionary: toArrayBuffer(dictionary) },
        debugging: { debug: false, verbose: false },
      });
      await service.initialize();
      this.service = service;
      return service;
    })();
    return this.loading;
  }

  async read(image: Uint8Array): Promise<OcrLine[]> {
    const service = await this.load();
    const result = await service.recognize(toArrayBuffer(image));
    return result.lines
      .map((words) => {
        const text = words.map((w) => w.text).join(" ").replace(/\s+/g, " ").trim();
        const x0 = Math.min(...words.map((w) => w.box.x));
        const y0 = Math.min(...words.map((w) => w.box.y));
        const x1 = Math.max(...words.map((w) => w.box.x + w.box.width));
        const y1 = Math.max(...words.map((w) => w.box.y + w.box.height));
        return { text, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, confidence: Math.min(...words.map((w) => w.confidence)) };
      })
      .filter((l) => l.text && l.box.w > 0 && l.box.h > 0 && Number.isFinite(l.confidence));
  }

  async destroy(): Promise<void> {
    await this.service?.destroy().catch(() => {});
    this.service = null;
    this.loading = null;
  }
}

export function paddleEngines(config: LocalConfig): { main: OcrEngine; second: OcrEngine } {
  const f = config.ocrFiles;
  return {
    main: new PaddleOcrEngine({ detection: f.detection, recognition: f.recognition, dictionary: f.dictionary }),
    second: new PaddleOcrEngine({ detection: f.secondDetection, recognition: f.secondRecognition, dictionary: f.secondDictionary }),
  };
}

/**
 * Compared without case or punctuation, but WITH word breaks: "Book now" =
 * "BOOK NOW", while "EarlyBird" ≠ "Early Bird" (a dropped space made a false
 * "misspelt headline" in the 2026-10-06 acceptance run).
 */
export const sameReading = (a: string, b: string) => {
  const n = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}%\s]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
  return n(a).length > 0 && n(a) === n(b);
};

export type Cropper = (image: Uint8Array, box: OcrLine["box"], padding: number) => Promise<Uint8Array>;

/** Crops a line (with padding) using sharp. */
export const sharpCropper: Cropper = async (image, box, padding) => {
  const sharp = (await import("sharp")).default;
  const meta = await sharp(image).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const left = Math.max(0, Math.floor(box.x - padding));
  const top = Math.max(0, Math.floor(box.y - padding));
  const width = Math.min(W - left, Math.ceil(box.w + padding * 2));
  const height = Math.min(H - top, Math.ceil(box.h + padding * 2));
  return new Uint8Array(await sharp(image).extract({ left, top, width: Math.max(1, width), height: Math.max(1, height) }).png().toBuffer());
};

/** Reads an image and returns the local-ocr-v1 JSON text. */
export async function readLocalOcr(engines: { main: OcrEngine; second: OcrEngine }, image: PreparedImage, crop: Cropper = sharpCropper, signal?: AbortSignal): Promise<string> {
  const lines = await engines.main.read(image.bytes);
  const out = [];
  for (const [i, line] of lines.entries()) {
    if (signal?.aborted) throw new Error("aborted");
    let secondRead: "agree" | "disagree" | "none" = "none";
    if (i < MAX_SECOND_READS) {
      const again = await engines.second.read(await crop(image.bytes, line.box, CROP_PADDING)).catch(() => null);
      secondRead = again && sameReading(line.text, again.map((l) => l.text).join(" ")) ? "agree" : "disagree";
    }
    out.push({ ...line, secondRead });
  }
  return JSON.stringify({ format: "local-ocr-v1", width: image.width, height: image.height, lines: out });
}
