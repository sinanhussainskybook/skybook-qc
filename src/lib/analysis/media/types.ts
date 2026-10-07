import type { MeasuredColours } from "@/lib/analysis/assemble";
import type { PreparedImage } from "@/lib/analysis/provider";
import type { OcrBlock } from "@/lib/analysis/validate";

/**
 * Local media preparation (D5 / D6): turns an uploaded file into the images
 * (and, for video, the audio) that are sent to providers — never the
 * original upload, which stays untouched in private Storage.
 */

/** One frame to analyse: an image, a PDF page, or a sampled video frame. */
export type PreparedFrame = {
  fileId: string;
  page?: number;
  timeMs?: number;
  intervalMs?: number;
  /** The ORIGINAL frame size (file, page or video) in pixels. */
  frame: { width: number; height: number };
  /** The image read by OCR. */
  ocrImage: PreparedImage;
  /** The image the AI judges; null for video frames that aren't key frames. */
  judgeImage: PreparedImage | null;
  /** Samples text / background / dominant colours from the pixels (measured). */
  measureColours?: (blocks: OcrBlock[]) => Promise<MeasuredColours>;
};

export type PreparedAudio = {
  /** Mono speech audio for the transcript (AI); absent when there is no sound. */
  bytes: Uint8Array | null;
  mime: "audio/mp3";
  durationMs: number;
  /** Measured by FFmpeg. */
  hasAudio: boolean;
  integratedLufs?: number;
  peakDbfs?: number;
};

export type PreparedContent = {
  frames: PreparedFrame[];
  /** Share (0–1) of this file that was analysed (pages / duration within the limits). */
  analysedShare: number;
  audio?: PreparedAudio | null;
  /** Set when the file can't be analysed; the reason is shown as "not verified". */
  unsupported?: string;
};

export type ContentFileInfo = {
  id: string;
  fileName: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  pages: number | null;
};

export interface MediaPreparer {
  prepareContent(file: ContentFileInfo, bytes: Uint8Array, workDir: string, signal: AbortSignal): Promise<PreparedContent>;
  /** The company's saved logo, prepared for the AI to compare with. */
  prepareLogo(bytes: Uint8Array, mimeType: string): Promise<PreparedImage | null>;
}

/**
 * The minimal preparer: PNG / JPEG content passed through as-is with its
 * measured size; anything else is "unsupported". Used by tests, and only
 * until the real local preparer (sharp / PDF renderer / FFmpeg) is set up.
 */
export class PassThroughPreparer implements MediaPreparer {
  async prepareContent(file: ContentFileInfo, bytes: Uint8Array): Promise<PreparedContent> {
    if ((file.mimeType !== "image/png" && file.mimeType !== "image/jpeg") || !file.width || !file.height) {
      return { frames: [], analysedShare: 0, unsupported: "this kind of file can't be prepared for analysis yet" };
    }
    const image: PreparedImage = { key: file.id, mime: file.mimeType, bytes, width: file.width, height: file.height, sourceName: file.fileName };
    return { frames: [{ fileId: file.id, frame: { width: file.width, height: file.height }, ocrImage: image, judgeImage: image }], analysedShare: 1 };
  }

  async prepareLogo(bytes: Uint8Array, mimeType: string): Promise<PreparedImage | null> {
    if (mimeType !== "image/png" && mimeType !== "image/jpeg") return null;
    return { key: "logo", mime: mimeType, bytes, width: 1, height: 1 };
  }
}
