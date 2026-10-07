import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LocalConfig } from "@/lib/analysis/local/config";
import { runFfmpeg } from "@/lib/analysis/media/video";
import { ProviderError, type TranscribeInput } from "@/lib/analysis/provider";

/**
 * Local speech-to-text with whisper.cpp (whisper-cli), run like FFmpeg: a
 * child process on files in a private temp folder that is always removed,
 * with a hard time limit. The audio never leaves this machine. The output is
 * mapped to the shared transcript JSON that validateTranscript checks.
 * Speech is AI evidence in the confidence policy, whatever its certainty.
 */

export type ProcessRunner = (bin: string, args: string[], signal: AbortSignal) => Promise<{ code: number }>;

export const runProcess: ProcessRunner = (bin, args, signal) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: "ignore", windowsHide: true });
    const kill = () => child.kill("SIGKILL");
    signal.addEventListener("abort", kill, { once: true });
    child.on("error", (error) => {
      signal.removeEventListener("abort", kill);
      reject(error);
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", kill);
      resolve({ code: code ?? -1 });
    });
  });

type WhisperJson = {
  transcription?: { offsets?: { from?: number; to?: number }; text?: string; tokens?: { text?: string; p?: number }[] }[];
};

/** Sound markers whisper writes instead of words. */
const NOT_SPEECH = /^(\[[^\]]*\]|\([^)]*\)|♪+|\*[^*]*\*)$/;

/** whisper-cli's full JSON (-ojf) → the shared transcript JSON text. */
export function whisperToTranscript(raw: string, durationMs: number): string {
  let json: WhisperJson;
  try {
    json = JSON.parse(raw) as WhisperJson;
  } catch {
    throw new ProviderError("The local speech reader's output wasn't valid.", "invalid_response");
  }
  const segments = [];
  for (const s of (json.transcription ?? []).slice(0, 2_000)) {
    const text = (s.text ?? "").replace(/\s+/g, " ").trim().slice(0, 2_000);
    if (!text || NOT_SPEECH.test(text)) continue;
    const startMs = Math.max(0, Math.round(s.offsets?.from ?? 0));
    const endMs = Math.min(durationMs, Math.round(s.offsets?.to ?? 0));
    if (endMs <= startMs) continue;
    const ps = (s.tokens ?? []).filter((t) => t.text && !/^\[_|^<\|/.test(t.text) && typeof t.p === "number").map((t) => t.p as number);
    const mean = ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0;
    segments.push({ startMs, endMs, text, certainty: mean >= 0.85 ? "clear" : mean >= 0.6 ? "likely" : "unsure" });
  }
  return JSON.stringify({ hasSpeech: segments.length > 0, segments });
}

export async function transcribeLocally(
  config: Pick<LocalConfig, "whisperBin" | "whisperModel" | "whisperLanguage" | "threads">,
  input: TranscribeInput,
  tempRoot: string,
  signal: AbortSignal,
  run: ProcessRunner = runProcess,
  toWav: (mp3: string, wav: string, signal: AbortSignal) => Promise<boolean> = async (mp3, wav, s) =>
    (await runFfmpeg(["-protocol_whitelist", "file", "-i", mp3, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], s)).code === 0
): Promise<string> {
  const dir = await mkdtemp(path.join(tempRoot, "whisper-"));
  try {
    const mp3 = path.join(dir, "audio.mp3");
    const wav = path.join(dir, "audio.wav");
    await writeFile(mp3, input.bytes);
    if (!(await toWav(mp3, wav, signal))) throw new ProviderError("The audio couldn't be prepared for the local speech reader.", "rejected");
    const out = path.join(dir, "transcript");
    const { code } = await run(
      config.whisperBin,
      ["-m", config.whisperModel, "-f", wav, "-t", String(config.threads), "-l", config.whisperLanguage, "-ojf", "-of", out, "-np"],
      signal
    );
    if (signal.aborted) throw new ProviderError("The request timed out.", "timeout");
    if (code !== 0) throw new ProviderError("The local speech reader failed.", "server");
    return whisperToTranscript(await readFile(`${out}.json`, "utf8"), input.durationMs);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
