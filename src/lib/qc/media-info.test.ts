import { describe, expect, it } from "vitest";
import { measureMedia } from "@/lib/qc/media-info";
import { checkFormatBytes } from "@/lib/qc/qc-file";
import { PNG } from "../../../test/logo-files";
import { jpegOf, mp4Of, pdfOf, pngOf, webmOf, webpOf } from "../../../test/media-samples";

describe("measuring uploaded content (Phase 5)", () => {
  it("the samples are real enough to pass the Phase 4 content check", () => {
    expect(checkFormatBytes("png", pngOf(10, 10))).toBeNull();
    expect(checkFormatBytes("jpeg", jpegOf(10, 10))).toBeNull();
    expect(checkFormatBytes("webp", webpOf(10, 10))).toBeNull();
    expect(checkFormatBytes("pdf", pdfOf(595, 842))).toBeNull();
    expect(checkFormatBytes("mp4", mp4Of(10, 10, 1000))).toBeNull();
    expect(checkFormatBytes("webm", webmOf(10, 10, 1000))).toBeNull();
  });

  describe("images", () => {
    it("PNG: size and DPI", () => {
      expect(measureMedia("png", pngOf(1080, 1350))).toEqual({ unit: "px", width: 1080, height: 1350 });
      expect(measureMedia("png", pngOf(2480, 3508, { dpi: 300 }))).toMatchObject({ width: 2480, height: 3508, dpi: 300 });
    });

    it("JPEG: size, density and EXIF orientation (sideways photos are measured upright)", () => {
      expect(measureMedia("jpeg", jpegOf(1920, 1080))).toEqual({ unit: "px", width: 1920, height: 1080 });
      expect(measureMedia("jpeg", jpegOf(1920, 1080, { dpi: 300 }))).toMatchObject({ dpi: 300 });
      expect(measureMedia("jpeg", jpegOf(1920, 1080, { orientation: 6 }))).toMatchObject({ width: 1080, height: 1920 });
      expect(measureMedia("jpeg", jpegOf(1920, 1080, { orientation: 3 }))).toMatchObject({ width: 1920, height: 1080 });
    });

    it("WEBP: lossy, lossless and extended", () => {
      expect(measureMedia("webp", webpOf(1440, 1800, "VP8X"))).toMatchObject({ width: 1440, height: 1800 });
      expect(measureMedia("webp", webpOf(800, 600, "VP8 "))).toMatchObject({ width: 800, height: 600 });
      expect(measureMedia("webp", webpOf(1200, 628, "VP8L"))).toMatchObject({ width: 1200, height: 628 });
    });

    it("a damaged / truncated image gives a note, never a made-up size", () => {
      const info = measureMedia("png", PNG); // only the first 16 bytes
      expect(info.width).toBeUndefined();
      expect(info.note).toBeTruthy();
    });
  });

  describe("PDF", () => {
    it("page size in points, rotation and page count", () => {
      expect(measureMedia("pdf", pdfOf(595.28, 841.89, { pages: 2 }))).toEqual({ unit: "pt", width: 595, height: 842, pages: 2 });
      expect(measureMedia("pdf", pdfOf(595.28, 841.89, { rotate: 90 }))).toMatchObject({ width: 842, height: 595 });
    });

    it("a compressed page size is reported as unreadable", () => {
      const info = measureMedia("pdf", pdfOf(595, 842, { compressed: true }));
      expect(info.width).toBeUndefined();
      expect(info.note).toMatch(/compressed/);
    });
  });

  describe("video", () => {
    it("MP4 / MOV: size and length; rotated phone videos are measured upright", () => {
      expect(measureMedia("mp4", mp4Of(1080, 1920, 15_000))).toEqual({ unit: "px", width: 1080, height: 1920, durationMs: 15_000 });
      expect(measureMedia("mov", mp4Of(1920, 1080, 4_000, { brand: "qt  " }))).toMatchObject({ width: 1920, height: 1080 });
      expect(measureMedia("mp4", mp4Of(1920, 1080, 4_000, { rotated: true }))).toMatchObject({ width: 1080, height: 1920 });
      expect(measureMedia("mp4", mp4Of(640, 360, 2_500, { moovAtEnd: true }))).toMatchObject({ width: 640, height: 360, durationMs: 2_500 });
    });

    it("MP4 whose details aren't in the bytes read: a note, not a guess", () => {
      const file = mp4Of(1080, 1920, 15_000, { moovAtEnd: true, mdatBytes: 100_000 });
      const info = measureMedia("mp4", file.subarray(0, 65_536));
      expect(info.width).toBeUndefined();
      expect(info.note).toMatch(/moov/);
    });

    it("WEBM: size and length", () => {
      expect(measureMedia("webm", webmOf(1080, 1920, 12_345))).toEqual({ unit: "px", width: 1080, height: 1920, durationMs: 12_345 });
    });
  });
});
