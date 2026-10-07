import os from "node:os";
import type { LocalConfig } from "@/lib/analysis/local/config";
import { checkLocalHealth, type LocalHealth } from "@/lib/analysis/local/health";
import { paddleEngines, readLocalOcr, sharpCropper, type Cropper, type OcrEngine } from "@/lib/analysis/local/ocr";
import { OllamaClient } from "@/lib/analysis/local/ollama";
import { runProcess, transcribeLocally, type ProcessRunner } from "@/lib/analysis/local/whisper";
import { EXTRACT_SYSTEM, extractSchema, extractUserText, JUDGE_SCHEMA, JUDGE_SYSTEM, judgeUserText, toJsonSchema } from "@/lib/analysis/prompts";
import {
  LOCAL_LABEL,
  ProviderError,
  type AnalysisProvider,
  type ExtractRequirementsInput,
  type JudgeImageInput,
  type PreparedImage,
  type TranscribeInput,
} from "@/lib/analysis/provider";

/**
 * The LOCAL provider (Local AI plan): everything runs on this server.
 *   readText            PaddleOCR (ONNX) + an independent second read per line
 *   judgeImage          Qwen3-VL instruct in Ollama on loopback, strict JSON schema
 *   transcribe          whisper.cpp
 *   extractRequirements the same Ollama model, text only, strict JSON schema
 * Like every provider it returns raw text that lib/analysis/validate.ts
 * checks; it never decides a finding, a severity or a result, and nothing
 * it returns is logged or stored raw. No call leaves this machine.
 */

export type LocalProviderDeps = {
  tempRoot: string;
  client?: OllamaClient;
  engines?: { main: OcrEngine; second: OcrEngine };
  crop?: Cropper;
  run?: ProcessRunner;
  toWav?: (mp3: string, wav: string, signal: AbortSignal) => Promise<boolean>;
  freeMemoryMb?: () => number;
  health?: () => Promise<LocalHealth>;
};

const JUDGE_CTX = 4_096;
const JUDGE_PREDICT = 800;
const HEALTH_RETRY_MS = 60_000;

const base64 = (image: PreparedImage) => Buffer.from(image.bytes).toString("base64");

export class LocalProvider implements AnalysisProvider {
  readonly name = "local" as const;
  readonly label = LOCAL_LABEL;
  readonly ocrFormat = "local-v1" as const;
  private readonly client: OllamaClient;
  private engines: { main: OcrEngine; second: OcrEngine } | null;
  private healthy: { ok: boolean; at: number; reason: string } | null = null;

  constructor(
    private readonly config: LocalConfig,
    private readonly deps: LocalProviderDeps
  ) {
    this.client = deps.client ?? new OllamaClient(config.ollamaUrl);
    this.engines = deps.engines ?? null;
  }

  /** The health check runs once (again a minute after a failure); a failing server fails runs with a plain reason. */
  private async ready(): Promise<void> {
    const now = Date.now();
    if (this.healthy?.ok) return;
    if (!this.healthy || now - this.healthy.at > HEALTH_RETRY_MS) {
      const health = await (this.deps.health ?? (() => checkLocalHealth(this.config, this.client)))().catch(() => ({ ok: false, checks: [{ name: "health check", ok: false, detail: "" }] }));
      const failed = health.checks.find((c) => !c.ok);
      this.healthy = { ok: health.ok, at: now, reason: failed ? failed.name : "" };
    }
    if (!this.healthy.ok) throw new ProviderError(`Local analysis isn't set up on this server (${this.healthy.reason}).`, "rejected");
  }

  private memoryGuard(): void {
    const free = (this.deps.freeMemoryMb ?? (() => os.freemem() / 1_048_576))();
    if (free < this.config.minFreeMb) throw new ProviderError("Not enough free memory on this server for the local AI right now.", "rejected");
  }

  private ocrEngines() {
    this.engines ??= paddleEngines(this.config);
    return this.engines;
  }

  async readText(image: PreparedImage, signal: AbortSignal): Promise<string> {
    await this.ready();
    return readLocalOcr(this.ocrEngines(), image, this.deps.crop ?? sharpCropper, signal);
  }

  async judgeImage(input: JudgeImageInput, signal: AbortSignal): Promise<string> {
    await this.ready();
    this.memoryGuard();
    return this.client.chat(
      {
        model: this.config.visionModel,
        format: toJsonSchema(JUDGE_SCHEMA),
        numCtx: JUDGE_CTX,
        numPredict: JUDGE_PREDICT,
        messages: [
          { role: "system", content: JUDGE_SYSTEM },
          { role: "user", content: judgeUserText(input.blocks, input.logo !== null), images: input.logo ? [base64(input.image), base64(input.logo)] : [base64(input.image)] },
        ],
      },
      signal
    );
  }

  async transcribe(input: TranscribeInput, signal: AbortSignal): Promise<string> {
    await this.ready();
    return transcribeLocally(this.config, input, this.deps.tempRoot, signal, this.deps.run ?? runProcess, this.deps.toWav);
  }

  async extractRequirements(input: ExtractRequirementsInput, signal: AbortSignal): Promise<string> {
    await this.ready();
    this.memoryGuard();
    // Roughly 3 characters per token, plus the instructions and the answer.
    const numCtx = Math.min(16_384, Math.max(4_096, Math.ceil(input.text.length / 3) + 2_000));
    return this.client.chat(
      {
        model: this.config.visionModel,
        format: toJsonSchema(extractSchema(input.allowedTypes)),
        numCtx,
        numPredict: 1_200,
        messages: [
          { role: "system", content: EXTRACT_SYSTEM },
          { role: "user", content: extractUserText(input) },
        ],
      },
      signal
    );
  }

  async close(): Promise<void> {
    await this.engines?.main.destroy();
    await this.engines?.second.destroy();
  }
}
