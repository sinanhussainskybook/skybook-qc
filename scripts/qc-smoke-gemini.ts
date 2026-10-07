/**
 * npm run qc:smoke:gemini -- --yes-call-gemini
 *
 * OPT-IN real smoke test of the Gemini API provider (Google AI Studio,
 * GEMINI_API_KEY): ONE design-analysis call on a synthetic design made here
 * (never customer content), validated with the same strict checks the
 * worker uses. Never part of `npm test`. Uses one request of the free-tier
 * quota. Prints PASS / FAIL, counts and timing only — never the key, the
 * request or the model's text.
 */
import sharp from "sharp";
import { readGeminiConfig } from "@/lib/analysis/gemini/config";
import { GeminiProvider } from "@/lib/analysis/gemini/gemini-provider";
import { prepareImage } from "@/lib/analysis/media/images";
import { validateDesignAnalysis } from "@/lib/analysis/validate";
import { loadLocalEnv } from "./lib/env";

async function main() {
  if (!process.argv.includes("--yes-call-gemini")) {
    console.log("This calls the Gemini API (uses free-tier quota). Re-run with:  npm run qc:smoke:gemini -- --yes-call-gemini");
    process.exitCode = 2;
    return;
  }
  loadLocalEnv();
  const config = readGeminiConfig();
  if (!config.ok) throw new Error(config.error);
  const provider = new GeminiProvider(config.value);
  console.log(`Model: ${config.value.model} · endpoint: Gemini API (generativelanguage.googleapis.com)`);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350"><rect width="100%" height="100%" fill="#ffffff"/>
    <text x="80" y="300" font-family="Arial" font-weight="bold" font-size="96" fill="#1A64B4">SMOKE TEST</text>
    <text x="80" y="420" font-family="Arial" font-size="56" fill="#000000">From AED 1,299</text>
    <rect x="80" y="1120" width="420" height="110" rx="55" fill="#E8641B"/>
    <text x="130" y="1195" font-family="Arial" font-weight="bold" font-size="56" fill="#ffffff">Book now</text></svg>`;
  const png = new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
  const image = await prepareImage(png, "smoke", 2048);
  const context = {
    companyName: "Smoke Test Co",
    requirements: [{ type: "price", label: null, value: "AED 1,299" }, { type: "cta", label: null, value: "Book now" }],
    goldenRules: [],
    brandColours: ["#1A64B4"],
    brandFonts: [],
    approvedTerms: [],
    bannedTerms: [],
  };

  const started = Date.now();
  let raw: string;
  try {
    raw = await provider.analyzeDesign({ image, logo: null, context }, AbortSignal.timeout(120_000));
  } catch (error) {
    console.log(`FAIL  Gemini design check — ${error instanceof Error ? error.message : "error"}`);
    process.exitCode = 1;
    return;
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const result = validateDesignAnalysis(raw, image.width, image.height);
  if (!result.ok) {
    console.log(`FAIL  Gemini design check — the answer didn't match the strict schema (${result.reason}), ${seconds} s`);
    process.exitCode = 1;
    return;
  }
  const { ocr, judgement } = result.value;
  const roles = judgement.blocks.map((b) => b.role);
  console.log(`PASS  Gemini design check — one call, ${seconds} s, matched the strict schema`);
  console.log(`      ${ocr.blocks.length} text line(s) read · roles: ${[...new Set(roles)].join(", ") || "none"} · ${judgement.imageIssues.length} image issue(s)`);
  const found = (s: string) => ocr.blocks.some((b) => b.text.toLowerCase().includes(s.toLowerCase()));
  console.log(`${found("AED 1,299") && found("Book now") ? "PASS" : "FAIL"}  the expected text was read (price and button)`);
  if (!found("AED 1,299") || !found("Book now")) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`Smoke test stopped: ${error instanceof Error ? error.message : "error"}`);
  process.exitCode = 1;
});
