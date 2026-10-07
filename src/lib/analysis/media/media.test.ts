import { mkdtemp, rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dominantColours, rawPixels, textColours } from "@/lib/analysis/media/colours";
import { orientedSize, prepareImage } from "@/lib/analysis/media/images";
import { LocalMediaPreparer } from "@/lib/analysis/media/local";
import { renderPdfPages } from "@/lib/analysis/media/pdf";
import { dropDuplicates, parseLoudness, prepareVideo, runFfmpeg, samplingIntervalMs } from "@/lib/analysis/media/video";
import { renderablePdf } from "../../../../test/media-samples";

/** Local media preparation — real sharp, MuPDF and FFmpeg, no network. */
describe("local media preparation", () => {
  let dir: string;
  const signal = () => new AbortController().signal;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "qc-media-test-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function poster(width: number, height: number) {
    // White background with a black "text" bar and a blue block.
    return new Uint8Array(
      await sharp({ create: { width, height, channels: 3, background: "#ffffff" } })
        .composite([
          { input: await sharp({ create: { width: Math.round(width * 0.5), height: Math.round(height * 0.05), channels: 3, background: "#000000" } }).png().toBuffer(), left: Math.round(width * 0.1), top: Math.round(height * 0.1) },
          { input: await sharp({ create: { width: Math.round(width * 0.3), height: Math.round(height * 0.3), channels: 3, background: "#1a64b4" } }).png().toBuffer(), left: Math.round(width * 0.6), top: Math.round(height * 0.6) },
        ])
        .png()
        .toBuffer()
    );
  }

  describe("images", () => {
    it("downscales to the long edge, stays under the byte limit, never changes the original", async () => {
      const original = await poster(5000, 3000);
      const copy = original.slice();
      const prepared = await prepareImage(original, "f1", 2048, "poster.png");
      expect(Math.max(prepared.width, prepared.height)).toBe(2048);
      expect(prepared.bytes.length).toBeLessThanOrEqual(6_500_000);
      expect(Buffer.compare(Buffer.from(original), Buffer.from(copy))).toBe(0);
      const noise = new Uint8Array(await sharp(Buffer.from(Array.from({ length: 800 * 800 * 3 }, () => Math.floor(Math.random() * 256))), { raw: { width: 800, height: 800, channels: 3 } }).png().toBuffer());
      const small = await prepareImage(noise, "f1", 4096, undefined, 400_000); // noise doesn't compress as PNG → JPEG
      expect(small.mime).toBe("image/jpeg");
      expect(small.bytes.length).toBeLessThanOrEqual(400_000);
    });

    it("applies EXIF orientation (a sideways phone photo is prepared upright)", async () => {
      const sideways = new Uint8Array(await sharp({ create: { width: 400, height: 200, channels: 3, background: "#808080" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer());
      expect(await orientedSize(sideways)).toEqual({ width: 200, height: 400 });
      const prepared = await prepareImage(sideways, "f1", 1000);
      expect([prepared.width, prepared.height]).toEqual([200, 400]);
    });

    it("refuses something that isn't an image", async () => {
      await expect(prepareImage(new Uint8Array([1, 2, 3, 4]), "f1", 100)).rejects.toThrow();
    });
  });

  describe("measured colours", () => {
    it("text vs background inside a box, and dominant colours", async () => {
      const raw = await rawPixels(await poster(1000, 1000));
      expect(textColours(raw, { x: 0.05, y: 0.05, w: 0.65, h: 0.2 })).toEqual({ color: "#000000", background: "#FFFFFF" });
      expect(textColours(raw, { x: 0.2, y: 0.4, w: 0.1, h: 0.1 })).toBeNull(); // flat: no text
      const dominant = dominantColours(raw);
      expect(dominant[0]).toMatchObject({ hex: "#FFFFFF" });
      expect(dominant.some((c) => c.hex === "#1A64B4")).toBe(true);
    });
  });

  describe("PDF", () => {
    it("renders allowed pages with page numbers; reports the page count", async () => {
      const result = await renderPdfPages(renderablePdf(3), 2);
      if ("unsupported" in result) throw new Error(result.unsupported);
      expect(result.pageCount).toBe(3);
      expect(result.pages.map((p) => p.page)).toEqual([1, 2]);
      expect(result.pages[0].height).toBeGreaterThan(result.pages[0].width);
    });

    it("garbage isn't a PDF", async () => {
      expect(await renderPdfPages(new Uint8Array([1, 2, 3]))).toMatchObject({ unsupported: expect.any(String) });
    });
  });

  describe("video (FFmpeg)", () => {
    let withAudio: Uint8Array;
    let silent: Uint8Array;

    beforeAll(async () => {
      // Test input made by FFmpeg itself: 2 s red, then 2 s blue, plus a tone.
      const out = path.join(dir, "test.mp4");
      const made = await runFfmpeg(
        [
          "-f", "lavfi", "-i", "color=c=red:s=320x240:d=2:r=10",
          "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=2:r=10",
          "-f", "lavfi", "-i", "sine=frequency=1000:duration=4",
          "-filter_complex", "[0][1]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2",
          "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out,
        ],
        signal()
      );
      expect(made.code).toBe(0);
      withAudio = new Uint8Array(await readFile(out));
      const quiet = path.join(dir, "silent.mp4");
      await runFfmpeg(["-f", "lavfi", "-i", "color=c=green:s=320x240:d=2:r=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", quiet], signal());
      silent = new Uint8Array(await readFile(quiet));
    }, 60_000);

    it("samples frames, drops duplicates, extracts speech audio and measures loudness / true peak", async () => {
      const work = await mkdtemp(path.join(dir, "run-"));
      const result = await prepareVideo(withAudio, 4000, work, signal());
      if ("unsupported" in result) throw new Error(result.unsupported);
      expect(result.sampledCount).toBe(4);
      expect(result.frames.map((f) => [f.timeMs, f.intervalMs])).toEqual([
        [0, 2000],
        [2000, 2000],
      ]);
      expect(result.audio.hasAudio).toBe(true);
      expect(result.audio.bytes!.length).toBeGreaterThan(1000);
      expect(result.audio.integratedLufs).toBeLessThan(0);
      expect(result.audio.peakDbfs).toBeLessThanOrEqual(0.5);
    }, 60_000);

    it("a video without sound: hasAudio false, nothing to transcribe", async () => {
      const work = await mkdtemp(path.join(dir, "run-"));
      const result = await prepareVideo(silent, 2000, work, signal());
      if ("unsupported" in result) throw new Error(result.unsupported);
      expect(result.audio).toEqual({ bytes: null, hasAudio: false });
    }, 60_000);

    it("not a video → unsupported, not an exception", async () => {
      const work = await mkdtemp(path.join(dir, "run-"));
      expect(await prepareVideo(new Uint8Array([0, 0, 0, 1]), 3000, work, signal())).toMatchObject({ unsupported: expect.any(String) });
    }, 60_000);

    it("sampling never exceeds 120 frames over at most 15 minutes", () => {
      expect(samplingIntervalMs(60_000)).toBe(1_000);
      expect(samplingIntervalMs(120_000)).toBe(1_000);
      expect(samplingIntervalMs(121_000)).toBe(2_000);
      expect(samplingIntervalMs(15 * 60_000)).toBe(8_000); // 900 s / 120 = 7.5 → 8 s
      expect(Math.floor((15 * 60_000) / samplingIntervalMs(15 * 60_000))).toBeLessThanOrEqual(120);
    });

    it("duplicate removal extends the kept frame's interval", async () => {
      const hashes = [0n, 0n, 0b111111n, 0b111111n, 0n];
      let i = 0;
      const frames = hashes.map((_, k) => ({ timeMs: k * 1000, intervalMs: 1000, png: new Uint8Array() }));
      const kept = await dropDuplicates(frames, async () => ({ hash: hashes[i++], mean: [10, 10, 10] }));
      expect(kept.map((f) => [f.timeMs, f.intervalMs])).toEqual([
        [0, 2000],
        [2000, 2000],
        [4000, 1000],
      ]);
    });

    it("a cut between two flat colours is NOT a duplicate (structure and colour both compared)", async () => {
      const flat = async (colour: string) => new Uint8Array(await sharp({ create: { width: 64, height: 48, channels: 3, background: colour } }).png().toBuffer());
      const kept = await dropDuplicates([
        { timeMs: 0, intervalMs: 1000, png: await flat("#ff0000") },
        { timeMs: 1000, intervalMs: 1000, png: await flat("#ff0000") },
        { timeMs: 2000, intervalMs: 1000, png: await flat("#0000ff") },
      ]);
      expect(kept.map((f) => [f.timeMs, f.intervalMs])).toEqual([
        [0, 2000],
        [2000, 1000],
      ]);
    });

    it("parses FFmpeg's loudness summary", () => {
      const stderr = "noise\n[Parsed_ebur128_0] Summary:\n\n  Integrated loudness:\n    I:         -16.3 LUFS\n    Threshold: -26.5 LUFS\n\n  True peak:\n    Peak:       -0.4 dBFS\n";
      expect(parseLoudness(stderr)).toEqual({ integratedLufs: -16.3, peakDbfs: -0.4 });
      expect(parseLoudness("Summary:\n    I:  -70.0 LUFS\n    Peak:  -inf dBFS")).toEqual({ integratedLufs: -70 });
    });
  });

  describe("LocalMediaPreparer", () => {
    it("image → one upright frame with OCR and judge images and a colour sampler", async () => {
      const prepared = await new LocalMediaPreparer().prepareContent(
        { id: "f1", fileName: "p.png", mimeType: "image/png", width: 5000, height: 3000, durationMs: null, pages: null },
        await poster(5000, 3000),
        dir,
        signal()
      );
      expect(prepared.analysedShare).toBe(1);
      expect(prepared.frames).toHaveLength(1);
      const [f] = prepared.frames;
      expect(f.frame).toEqual({ width: 5000, height: 3000 });
      expect(Math.max(f.ocrImage.width, f.ocrImage.height)).toBe(4096);
      expect(Math.max(f.judgeImage!.width, f.judgeImage!.height)).toBe(2048);
      expect(typeof f.measureColours).toBe("function");
    });

    it("PDF → one frame per allowed page; coverage reflects the rest", async () => {
      const prepared = await new LocalMediaPreparer().prepareContent(
        { id: "f2", fileName: "brochure.pdf", mimeType: "application/pdf", width: 595, height: 842, durationMs: null, pages: 12 },
        renderablePdf(12),
        dir,
        signal()
      );
      expect(prepared.frames.map((f) => f.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(prepared.analysedShare).toBeCloseTo(10 / 12);
    }, 60_000);

    it("unsupported files say why", async () => {
      const prepared = await new LocalMediaPreparer().prepareContent(
        { id: "f3", fileName: "x.png", mimeType: "image/png", width: 1, height: 1, durationMs: null, pages: null },
        new Uint8Array([1, 2, 3]),
        dir,
        signal()
      );
      expect(prepared).toMatchObject({ frames: [], unsupported: "the file couldn't be prepared for analysis" });
    });
  });
});
