import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import type { LocalConfig } from "@/lib/analysis/local/config";
import { PINNED_FILE_SHA256 } from "@/lib/analysis/local/config";
import { OllamaClient } from "@/lib/analysis/local/ollama";
import { ffmpegPath } from "@/lib/analysis/media/video";

/**
 * Is this server ready for local analysis? Checks, without downloading
 * anything: every model file against its pinned SHA-256; whisper-cli and
 * FFmpeg present; the vision model installed in Ollama (on loopback) with
 * the pinned digest, able to see images, and NOT a "thinking" model (those
 * spent 17+ minutes per design in the 2026-10-06 trial).
 * Results name the check only — never file contents or model output.
 */

export type HealthCheck = { name: string; ok: boolean; detail: string };
export type LocalHealth = { ok: boolean; checks: HealthCheck[] };

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function checkLocalHealth(config: LocalConfig, client: OllamaClient = new OllamaClient(config.ollamaUrl), signal: AbortSignal = AbortSignal.timeout(30_000)): Promise<LocalHealth> {
  const checks: HealthCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const pinned = [
    ...Object.values(config.ocrFiles).map((f) => ({ file: f, sha: PINNED_FILE_SHA256[path.basename(f)] })),
    { file: config.whisperModel, sha: config.whisperModelSha256 },
  ];
  for (const { file, sha } of pinned) {
    const name = path.basename(file);
    if (!existsSync(file)) {
      add(name, false, "missing");
      continue;
    }
    const actual = await sha256File(file).catch(() => "");
    add(name, actual === sha, actual === sha ? "checksum matches" : "checksum does NOT match the pinned value");
  }
  add("whisper-cli", existsSync(config.whisperBin), existsSync(config.whisperBin) ? "present" : "missing");
  let ff = "";
  try {
    ff = ffmpegPath();
  } catch {
    ff = "";
  }
  add("FFmpeg", !!ff && existsSync(ff), ff && existsSync(ff) ? "present" : "missing");

  try {
    const models = await client.tags(signal);
    const model = models.find((m) => m.name === config.visionModel);
    if (!model) {
      add(config.visionModel, false, "not installed in the local Ollama");
    } else {
      add(config.visionModel, model.digest === config.visionModelDigest, model.digest === config.visionModelDigest ? "digest matches" : "digest does NOT match the pinned value");
      const caps = await client.capabilities(config.visionModel, signal);
      add("vision capability", caps.includes("vision"), caps.includes("vision") ? "yes" : "the model can't read images");
      add("not a thinking model", !caps.includes("thinking"), caps.includes("thinking") ? "use an -instruct tag" : "yes");
    }
  } catch {
    add("Ollama (loopback)", false, "not reachable on this machine");
  }
  return { ok: checks.every((c) => c.ok), checks };
}
