/**
 * npm run qc:smoke:local -- --yes-run-local
 *
 * OPT-IN smoke test of the LOCAL provider with the real local models on a
 * synthetic design made here (never customer content): OCR + second read,
 * one vision judgement (Ollama on loopback), one transcript of a generated
 * tone (no speech expected). Slow on a CPU-only machine (minutes). Never part
 * of `npm test`. Prints PASS / FAIL, counts and timings only.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { readLocalConfig } from "@/lib/analysis/local/config";
import { LocalProvider } from "@/lib/analysis/local/local-provider";
import { prepareImage } from "@/lib/analysis/media/images";
import { ffmpegPath } from "@/lib/analysis/media/video";
import { validateImageJudgement, validateLocalOcr, validateTranscript } from "@/lib/analysis/validate";
import { loadLocalEnv } from "./lib/env";

async function main() {
  if (!process.argv.includes("--yes-run-local")) {
    console.log("This runs the local AI models (slow on CPU). Re-run with:  npm run qc:smoke:local -- --yes-run-local");
    process.exitCode = 2;
    return;
  }
  loadLocalEnv();
  const config = readLocalConfig();
  if (!config.ok) throw new Error(config.error);
  const temp = await mkdtemp(path.join(os.tmpdir(), "skybook-qc-smoke-"));
  const provider = new LocalProvider(config.value, { tempRoot: temp });
  let failures = 0;
  const report = (ok: boolean, line: string) => {
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${line}`);
  };
  try {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350"><rect width="100%" height="100%" fill="#ffffff"/>
      <text x="80" y="300" font-family="Arial" font-weight="bold" font-size="96" fill="#1A64B4">SMOKE TEST</text>
      <text x="80" y="1200" font-family="Arial" font-size="56" fill="#000000">Book now</text></svg>`;
    const png = new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
    const ocrImage = await prepareImage(png, "smoke", 4096);
    const signal = AbortSignal.timeout(900_000);

    let t = Date.now();
    const ocr = validateLocalOcr(await provider.readText(ocrImage, signal), ocrImage.width, ocrImage.height);
    report(ocr.ok && ocr.value.blocks.length >= 2, `local OCR — ${ocr.ok ? ocr.value.blocks.length : 0} line(s), ${Date.now() - t} ms`);
    if (!ocr.ok) return;

    const judgeImage = await prepareImage(png, "smoke", 1024);
    const blocks = ocr.value.blocks.map((b) => ({ id: b.id, text: b.text }));
    t = Date.now();
    const judged = validateImageJudgement(await provider.judgeImage({ image: judgeImage, logo: null, blocks }, signal), new Set(blocks.map((b) => b.id)));
    report(judged.ok, `local vision judgement — ${judged.ok ? "matched the strict schema" : judged.reason}, ${Math.round((Date.now() - t) / 1000)} s`);

    const mp3 = path.join(temp, "tone.mp3");
    execFileSync(ffmpegPath(), ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ac", "1", mp3], { stdio: "ignore" });
    t = Date.now();
    const heard = validateTranscript(await provider.transcribe({ mime: "audio/mp3", bytes: new Uint8Array(readFileSync(mp3)), durationMs: 3000 }, signal), 3000);
    report(heard.ok, `local transcript (a tone) — ${heard.ok ? `${heard.value.segments.length} speech segment(s)` : heard.reason}, ${Date.now() - t} ms`);
  } finally {
    await provider.close();
    await rm(temp, { recursive: true, force: true });
  }
  if (failures) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`Smoke test stopped: ${error instanceof Error ? error.message : "error"}`);
  process.exitCode = 1;
});
