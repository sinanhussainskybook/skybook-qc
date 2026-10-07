/**
 * npm run qc:smoke:google -- --yes-call-google
 *
 * OPT-IN real-provider smoke test (Phase 6, 6.12). Calls Google Cloud Vision
 * and Gemini ONCE each, on the EU endpoints, with a synthetic test image made
 * here (never customer content). Never part of `npm test`.
 *
 * Needs GOOGLE_CLOUD_PROJECT and GOOGLE_APPLICATION_CREDENTIALS (see
 * .env.example). Prints only PASS / FAIL lines and counts — no credentials,
 * no request or response content.
 */
import sharp from "sharp";
import { readGoogleConfig } from "@/lib/analysis/google/config";
import { GoogleProvider, serviceAccountTokens } from "@/lib/analysis/google/google-provider";
import { prepareImage } from "@/lib/analysis/media/images";
import { validateImageJudgement, validateOcrResponse } from "@/lib/analysis/validate";
import { loadLocalEnv } from "./lib/env";

async function main() {
  if (!process.argv.includes("--yes-call-google")) {
    console.log("This calls Google Cloud (billable). Re-run with:  npm run qc:smoke:google -- --yes-call-google");
    process.exitCode = 2;
    return;
  }
  loadLocalEnv();
  const config = readGoogleConfig();
  if (!config.ok) throw new Error(config.error);
  const provider = new GoogleProvider(config.value, serviceAccountTokens(config.value.credentialsFile));
  console.log(`Region: ${config.value.region} · model: ${config.value.model}`);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350"><rect width="100%" height="100%" fill="#ffffff"/>
    <text x="80" y="300" font-family="Arial" font-size="96" font-weight="bold" fill="#1A64B4">SMOKE TEST</text>
    <text x="80" y="1200" font-family="Arial" font-size="56" fill="#000000">Book now</text></svg>`;
  const png = new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
  const image = await prepareImage(png, "smoke", 2048);
  const signal = AbortSignal.timeout(90_000);

  const ocr = validateOcrResponse(await provider.readText(image, signal), image.width, image.height);
  console.log(ocr.ok ? `PASS  Cloud Vision OCR — ${ocr.value.blocks.length} text block(s), page confidence ${ocr.value.pageConfidence.toFixed(2)}` : `FAIL  Cloud Vision OCR — ${ocr.reason}`);
  if (!ocr.ok) return void (process.exitCode = 1);

  const blocks = ocr.value.blocks.map((b) => ({ id: b.id, text: b.text }));
  const judged = validateImageJudgement(await provider.judgeImage({ image, logo: null, blocks }, signal), new Set(blocks.map((b) => b.id)));
  console.log(judged.ok ? `PASS  Gemini judgement — ${judged.value.blocks.length} block(s) labelled, response matched the strict schema` : `FAIL  Gemini judgement — ${judged.reason}`);
  if (!judged.ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`Smoke test stopped: ${error instanceof Error ? error.message : "error"}`);
  process.exitCode = 1;
});
