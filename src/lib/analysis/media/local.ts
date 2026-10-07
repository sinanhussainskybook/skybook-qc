import { ANALYSIS_LIMITS, type AnalysisLimits } from "@/lib/analysis/limits";
import { colourSampler } from "@/lib/analysis/media/colours";
import { orientedSize, prepareImage } from "@/lib/analysis/media/images";
import { renderPdfPages } from "@/lib/analysis/media/pdf";
import type { ContentFileInfo, MediaPreparer, PreparedContent, PreparedFrame } from "@/lib/analysis/media/types";
import { prepareVideo } from "@/lib/analysis/media/video";
import type { PreparedImage } from "@/lib/analysis/provider";

/**
 * The real local preparer (D5 / D6): images (sharp), PDF pages (MuPDF) and
 * video (FFmpeg). Everything happens on this server; providers receive only
 * the prepared images and audio.
 */
export class LocalMediaPreparer implements MediaPreparer {
  constructor(private readonly limits: AnalysisLimits = ANALYSIS_LIMITS) {}

  async prepareContent(file: ContentFileInfo, bytes: Uint8Array, workDir: string, signal: AbortSignal): Promise<PreparedContent> {
    try {
      if (file.mimeType === "application/pdf") return await this.pdf(file, bytes);
      if (file.mimeType.startsWith("video/")) return await this.video(file, bytes, workDir, signal);
      if (file.mimeType.startsWith("image/")) return await this.image(file, bytes);
      return { frames: [], analysedShare: 0, unsupported: "this kind of file can't be analysed" };
    } catch (error) {
      if (signal.aborted) throw error;
      return { frames: [], analysedShare: 0, unsupported: "the file couldn't be prepared for analysis" };
    }
  }

  async prepareLogo(bytes: Uint8Array): Promise<PreparedImage | null> {
    try {
      return await prepareImage(bytes, "logo", 1024);
    } catch {
      return null;
    }
  }

  private async frameFrom(fileId: string, key: string, bytes: Uint8Array, sourceName: string, extra: Partial<PreparedFrame> & { frame: PreparedFrame["frame"] }): Promise<PreparedFrame> {
    const ocrImage = await prepareImage(bytes, key, this.limits.ocrImageLongEdge, sourceName);
    const judgeImage = extra.judgeImage === null ? null : await prepareImage(bytes, key, this.limits.judgeImageLongEdge, sourceName);
    return { ...extra, fileId, ocrImage, judgeImage, measureColours: colourSampler(ocrImage.bytes) };
  }

  private async image(file: ContentFileInfo, bytes: Uint8Array): Promise<PreparedContent> {
    const frame = await orientedSize(bytes);
    if (!frame.width || !frame.height) return { frames: [], analysedShare: 0, unsupported: "the image's size couldn't be read" };
    return { frames: [await this.frameFrom(file.id, file.id, bytes, file.fileName, { frame })], analysedShare: 1 };
  }

  private async pdf(file: ContentFileInfo, bytes: Uint8Array): Promise<PreparedContent> {
    const rendered = await renderPdfPages(bytes, this.limits.maxPagesPerFile);
    if ("unsupported" in rendered) return { frames: [], analysedShare: 0, unsupported: rendered.unsupported };
    const frames: PreparedFrame[] = [];
    for (const p of rendered.pages) {
      frames.push(await this.frameFrom(file.id, `${file.id}#p${p.page}`, p.png, file.fileName, { page: p.page, frame: { width: p.width, height: p.height } }));
    }
    return { frames, analysedShare: rendered.pageCount ? rendered.pages.length / rendered.pageCount : 0 };
  }

  private async video(file: ContentFileInfo, bytes: Uint8Array, workDir: string, signal: AbortSignal): Promise<PreparedContent> {
    const video = await prepareVideo(bytes, file.durationMs, workDir, signal);
    if ("unsupported" in video) return { frames: [], analysedShare: 0, unsupported: video.unsupported };
    const frame = { width: file.width ?? 0, height: file.height ?? 0 };
    // Up to 8 key frames (local CPU: 3), spread over the video, are also judged by the AI.
    const step = Math.max(1, Math.ceil(video.frames.length / this.limits.maxKeyFramesPerVideo));
    const frames: PreparedFrame[] = [];
    for (const [i, f] of video.frames.entries()) {
      const size = frame.width && frame.height ? frame : await orientedSize(f.png);
      frames.push(
        await this.frameFrom(file.id, `${file.id}@${f.timeMs}`, f.png, file.fileName, {
          frame: size,
          timeMs: f.timeMs,
          intervalMs: f.intervalMs,
          ...(i % step === 0 ? {} : { judgeImage: null }),
        })
      );
    }
    return {
      frames,
      analysedShare: video.durationMs ? video.analysedMs / video.durationMs : 0,
      audio: { bytes: video.audio.bytes, mime: "audio/mp3", durationMs: video.analysedMs, hasAudio: video.audio.hasAudio, integratedLufs: video.audio.integratedLufs, peakDbfs: video.audio.peakDbfs },
    };
  }
}
