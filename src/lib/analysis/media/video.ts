import { spawn } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import ffmpegStatic from "ffmpeg-static";
import { ANALYSIS_LIMITS } from "@/lib/analysis/limits";

/**
 * Video processing with FFmpeg (D6) — the original video never leaves the
 * server. Only local files (no network protocols), a time limit and a thread
 * limit on every command:
 *   - frames sampled at ≥ 1 s intervals (at most 120 over at most 15 min);
 *   - near-identical consecutive frames dropped (perceptual hash);
 *   - mono speech audio (MP3) for the transcript;
 *   - integrated loudness (LUFS) and true peak (dBFS), measured.
 */

export function ffmpegPath(): string {
  const configured = process.env.FFMPEG_PATH?.trim();
  if (configured) return configured;
  if (!ffmpegStatic) throw new Error("FFmpeg isn't available on this host.");
  return ffmpegStatic as unknown as string;
}

const BASE_ARGS = ["-hide_banner", "-nostdin", "-y", "-threads", "2"];
const INPUT_ARGS = (file: string) => ["-protocol_whitelist", "file", "-i", file];

/** Runs FFmpeg with a hard time limit; resolves with stderr (where FFmpeg reports). */
export function runFfmpeg(args: string[], signal: AbortSignal, timeoutMs: number = ANALYSIS_LIMITS.ffmpegTimeoutMs): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), [...BASE_ARGS, ...args], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 200_000) stderr += chunk.toString("utf8");
    });
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(kill, timeoutMs);
    signal.addEventListener("abort", kill, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

/**
 * What a frame looks like, cheaply: a 64-bit difference hash (structure —
 * edges, text) plus its average colour. A difference hash alone is blind to
 * a cut between two flat colours, so both must match for a duplicate.
 */
export type FrameSignature = { hash: bigint; mean: [number, number, number] };

export async function frameSignature(png: Uint8Array): Promise<FrameSignature> {
  const grey = await sharp(png).greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  let hash = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) hash = (hash << 1n) | (grey[y * 9 + x] > grey[y * 9 + x + 1] ? 1n : 0n);
  const { channels } = await sharp(png).removeAlpha().stats();
  return { hash, mean: [channels[0].mean, channels[1].mean, channels[2].mean] };
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

/** Frames within this many differing hash bits, and this much average colour, count as the same picture. */
export const DUPLICATE_DISTANCE = 3;
export const DUPLICATE_COLOUR = 12;

export function sameFrame(a: FrameSignature, b: FrameSignature): boolean {
  return hammingDistance(a.hash, b.hash) <= DUPLICATE_DISTANCE && a.mean.every((v, i) => Math.abs(v - b.mean[i]) <= DUPLICATE_COLOUR);
}

export type SampledFrame = { timeMs: number; intervalMs: number; png: Uint8Array };

export type VideoPreparation = {
  frames: SampledFrame[];
  sampledCount: number;
  analysedMs: number;
  durationMs: number;
  audio: { bytes: Uint8Array | null; hasAudio: boolean; integratedLufs?: number; peakDbfs?: number };
};

/** The sampling interval: at least 1 s, and never more than the frame cap over the analysed length. */
export function samplingIntervalMs(analysedMs: number): number {
  return Math.max(1_000, Math.ceil(analysedMs / ANALYSIS_LIMITS.maxOcrFramesPerVideo / 1000) * 1000);
}

/** Drops near-identical consecutive frames; a kept frame's interval runs to the next kept frame. */
export async function dropDuplicates(
  frames: SampledFrame[],
  signature: (png: Uint8Array) => Promise<FrameSignature> = frameSignature
): Promise<SampledFrame[]> {
  const kept: (SampledFrame & { signature: FrameSignature })[] = [];
  for (const frame of frames) {
    const sig = await signature(frame.png);
    const previous = kept[kept.length - 1];
    if (previous && sameFrame(previous.signature, sig)) {
      previous.intervalMs = frame.timeMs + frame.intervalMs - previous.timeMs;
      continue;
    }
    kept.push({ ...frame, signature: sig });
  }
  return kept.map((k) => ({ timeMs: k.timeMs, intervalMs: k.intervalMs, png: k.png }));
}

export function parseLoudness(stderr: string): { integratedLufs?: number; peakDbfs?: number } {
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const integrated = /I:\s+(-?\d+(?:\.\d+)?)\s+LUFS/.exec(summary);
  const peak = /Peak:\s+(-?\d+(?:\.\d+)?|-inf)\s+dBFS/.exec(summary);
  return {
    ...(integrated ? { integratedLufs: Number(integrated[1]) } : {}),
    ...(peak && peak[1] !== "-inf" ? { peakDbfs: Number(peak[1]) } : {}),
  };
}

export async function prepareVideo(bytes: Uint8Array, durationMs: number | null, workDir: string, signal: AbortSignal): Promise<VideoPreparation | { unsupported: string }> {
  const input = path.join(workDir, "input.video");
  await writeFile(input, bytes);
  let duration = durationMs ?? 0;
  if (!duration) {
    const probe = await runFfmpeg([...INPUT_ARGS(input)], signal);
    const m = /Duration:\s+(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(probe.stderr);
    if (m) duration = Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000);
  }
  if (!duration) return { unsupported: "the video's length couldn't be read" };
  const analysedMs = Math.min(duration, ANALYSIS_LIMITS.maxVideoAnalysedMs);
  const seconds = (analysedMs / 1000).toFixed(3);
  const interval = samplingIntervalMs(analysedMs);

  // Frames, at most 1280 px wide (enough for on-screen text; keeps OCR requests small).
  const extracted = await runFfmpeg(
    [...INPUT_ARGS(input), "-t", seconds, "-vf", `fps=1000/${interval},scale='min(1280,iw)':-2`, "-frames:v", String(ANALYSIS_LIMITS.maxOcrFramesPerVideo), path.join(workDir, "frame_%04d.png")],
    signal
  );
  const names = (await readdir(workDir)).filter((n) => /^frame_\d{4}\.png$/.test(n)).sort();
  if (extracted.code !== 0 || !names.length) return { unsupported: "the video's frames couldn't be read" };
  const sampled: SampledFrame[] = [];
  for (const [i, name] of names.entries()) {
    sampled.push({ timeMs: i * interval, intervalMs: interval, png: new Uint8Array(await readFile(path.join(workDir, name))) });
  }
  const frames = await dropDuplicates(sampled);

  // Sound: speech audio for the transcript, and measured loudness / true peak.
  const audioFile = path.join(workDir, "speech.mp3");
  const audioRun = await runFfmpeg([...INPUT_ARGS(input), "-t", seconds, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k", audioFile], signal);
  const hasAudio = audioRun.code === 0 && !/does not contain any stream|matches no streams/i.test(audioRun.stderr);
  let loudness: { integratedLufs?: number; peakDbfs?: number } = {};
  let audioBytes: Uint8Array | null = null;
  if (hasAudio) {
    audioBytes = new Uint8Array(await readFile(audioFile));
    const measured = await runFfmpeg([...INPUT_ARGS(input), "-t", seconds, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"], signal);
    loudness = parseLoudness(measured.stderr);
  }
  return {
    frames,
    sampledCount: sampled.length,
    analysedMs,
    durationMs: duration,
    audio: { bytes: audioBytes, hasAudio, ...loudness },
  };
}
