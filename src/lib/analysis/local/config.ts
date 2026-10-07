import { existsSync } from "node:fs";
import path from "node:path";
import type { LocalProfile } from "@/lib/analysis/limits";

/**
 * Settings for the LOCAL provider (Local AI plan): PaddleOCR (ONNX, in the
 * worker), a vision model in Ollama on THIS machine, and whisper.cpp. Read
 * on the server only; none of these are secrets.
 *
 *   QC_LOCAL_PROFILE            cpu (testing only) | gpu (production target)
 *   QC_LOCAL_OLLAMA_URL         http://127.0.0.1:11434 — loopback ONLY
 *   QC_LOCAL_VISION_MODEL       qwen3-vl:4b-instruct (an instruct tag; never a "thinking" or cloud model)
 *   QC_LOCAL_VISION_MODEL_DIGEST  required for a model not pinned below
 *   QC_LOCAL_MODELS_DIR         folder with ocr/ and whisper/ (outside the project / OneDrive)
 *   QC_LOCAL_WHISPER_BIN        path to whisper-cli(.exe)
 *   QC_LOCAL_WHISPER_MODEL      file name in <models>/whisper (default ggml-base.en.bin)
 *   QC_LOCAL_WHISPER_MODEL_SHA256  required for a whisper model not pinned below
 *   QC_LOCAL_WHISPER_LANGUAGE   auto (default; "en" for *.en models)
 *   QC_LOCAL_THREADS            CPU threads for whisper (default 4)
 *   QC_LOCAL_MIN_FREE_MB        skip an AI call when free RAM is below this (default 512)
 *
 * Nothing is downloaded at run time: every model file is checked against a
 * pinned SHA-256 (lib/analysis/local/health.ts) before it is used.
 */

/** Ollama models known to work (instruct, vision), pinned by digest. */
export const PINNED_VISION_MODELS: Record<string, string> = {
  "qwen3-vl:4b-instruct": "ee4b975b58c17ce268cd19d40db35d5edc64603035d2ffc1fee1968eb0947f7b",
};

/** OCR model files (PP-OCRv6 tiny = main read; PP-OCRv5 English mobile = independent second read). */
export const OCR_FILES = {
  detection: "PP-OCRv6_tiny_det.ort",
  recognition: "PP-OCRv6_tiny_rec.ort",
  dictionary: "ppocrv6_tiny_dict.txt",
  secondDetection: "PP-OCRv5_mobile_det_infer.ort",
  secondRecognition: "en_PP-OCRv5_mobile_rec_infer.ort",
  secondDictionary: "ppocrv5_en_dict.txt",
} as const;

export const PINNED_FILE_SHA256: Record<string, string> = {
  "PP-OCRv6_tiny_det.ort": "2816e82d26a09d6af722492f80f3059d458377c084eca88f34d84ddf9b385580",
  "PP-OCRv6_tiny_rec.ort": "efc46adf1bde1e05b58748268abb0e71791bfa8616c435676bbca13d1ea47767",
  "ppocrv6_tiny_dict.txt": "2f3717bbd530b681b6db3be35cc485e8a41a932b9558b833986bf0894eb21f2d",
  "PP-OCRv5_mobile_det_infer.ort": "30acfc4e21f2a23669d01a75aaeb92190f96874613108a0f7086bed264420abc",
  "en_PP-OCRv5_mobile_rec_infer.ort": "74ff9e508379375b5149a3c7764221fa9ba7680b7e2f2e458f26b7c7993a89b0",
  "ppocrv5_en_dict.txt": "c60d46e9e01d500ed6388fe8681051eac9cf6692e0d57238315be171927a0a1b",
  "ggml-base.en.bin": "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
};

export type LocalConfig = {
  profile: LocalProfile;
  ollamaUrl: string;
  visionModel: string;
  visionModelDigest: string;
  modelsDir: string;
  ocrFiles: Record<keyof typeof OCR_FILES, string>;
  whisperBin: string;
  whisperModel: string;
  whisperModelSha256: string;
  whisperLanguage: string;
  threads: number;
  minFreeMb: number;
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** True only for http://<loopback>:<port> with no credentials, path or query. */
export function isLoopbackUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" && LOOPBACK.has(url.hostname) && !url.username && !url.password && (url.pathname === "/" || url.pathname === "") && !url.search && !url.hash;
}

export function readLocalConfig(env: Record<string, string | undefined> = process.env): { ok: true; value: LocalConfig } | { ok: false; error: string } {
  const profile = (env.QC_LOCAL_PROFILE?.trim().toLowerCase() || "cpu") as string;
  if (profile !== "cpu" && profile !== "gpu") return { ok: false, error: "QC_LOCAL_PROFILE must be cpu or gpu." };

  const ollamaUrl = (env.QC_LOCAL_OLLAMA_URL?.trim() || "http://127.0.0.1:11434").replace(/\/$/, "");
  if (!isLoopbackUrl(ollamaUrl)) return { ok: false, error: "QC_LOCAL_OLLAMA_URL must be http://127.0.0.1:<port> (loopback only)." };

  const visionModel = env.QC_LOCAL_VISION_MODEL?.trim() || "qwen3-vl:4b-instruct";
  if (!/^[a-z0-9][a-z0-9._-]{0,60}:[a-z0-9][a-z0-9._-]{0,60}$/.test(visionModel)) return { ok: false, error: "QC_LOCAL_VISION_MODEL must be a model name with an explicit tag, e.g. qwen3-vl:4b-instruct." };
  if (/cloud/.test(visionModel)) return { ok: false, error: "QC_LOCAL_VISION_MODEL can't be a cloud model." };
  const visionModelDigest = (env.QC_LOCAL_VISION_MODEL_DIGEST?.trim().toLowerCase() || PINNED_VISION_MODELS[visionModel] || "");
  if (!/^[a-f0-9]{64}$/.test(visionModelDigest)) return { ok: false, error: "QC_LOCAL_VISION_MODEL_DIGEST is needed for a model that isn't pinned." };

  const modelsDir = env.QC_LOCAL_MODELS_DIR?.trim() ?? "";
  if (!modelsDir || !path.isAbsolute(modelsDir)) return { ok: false, error: "QC_LOCAL_MODELS_DIR must be an absolute folder path." };
  const ocrFiles = Object.fromEntries(Object.entries(OCR_FILES).map(([k, name]) => [k, path.join(modelsDir, "ocr", name)])) as LocalConfig["ocrFiles"];

  const whisperBin = env.QC_LOCAL_WHISPER_BIN?.trim() ?? "";
  if (!whisperBin || !path.isAbsolute(whisperBin)) return { ok: false, error: "QC_LOCAL_WHISPER_BIN must be the absolute path of whisper-cli." };
  const whisperName = env.QC_LOCAL_WHISPER_MODEL?.trim() || "ggml-base.en.bin";
  if (!/^ggml-[a-z0-9._-]+\.bin$/.test(whisperName)) return { ok: false, error: "QC_LOCAL_WHISPER_MODEL must be a ggml-*.bin file name." };
  const whisperModelSha256 = (env.QC_LOCAL_WHISPER_MODEL_SHA256?.trim().toLowerCase() || PINNED_FILE_SHA256[whisperName] || "");
  if (!/^[a-f0-9]{64}$/.test(whisperModelSha256)) return { ok: false, error: "QC_LOCAL_WHISPER_MODEL_SHA256 is needed for a whisper model that isn't pinned." };
  const whisperLanguage = env.QC_LOCAL_WHISPER_LANGUAGE?.trim().toLowerCase() || (whisperName.includes(".en.") ? "en" : "auto");
  if (!/^(auto|[a-z]{2})$/.test(whisperLanguage)) return { ok: false, error: "QC_LOCAL_WHISPER_LANGUAGE must be auto or a two-letter code." };

  const threads = Number(env.QC_LOCAL_THREADS ?? 4);
  if (!Number.isInteger(threads) || threads < 1 || threads > 64) return { ok: false, error: "QC_LOCAL_THREADS must be 1–64." };
  const minFreeMb = Number(env.QC_LOCAL_MIN_FREE_MB ?? 512);
  if (!Number.isFinite(minFreeMb) || minFreeMb < 0 || minFreeMb > 65_536) return { ok: false, error: "QC_LOCAL_MIN_FREE_MB must be 0–65536." };

  return {
    ok: true,
    value: {
      profile,
      ollamaUrl,
      visionModel,
      visionModelDigest,
      modelsDir,
      ocrFiles,
      whisperBin,
      whisperModel: path.join(modelsDir, "whisper", whisperName),
      whisperModelSha256,
      whisperLanguage,
      threads,
      minFreeMb,
    },
  };
}

/** Quick presence check (the full checksum check is in health.ts). */
export function missingLocalFiles(config: LocalConfig): string[] {
  return [...Object.values(config.ocrFiles), config.whisperModel, config.whisperBin].filter((f) => !existsSync(f)).map((f) => path.basename(f));
}
