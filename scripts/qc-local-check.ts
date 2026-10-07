/**
 * npm run qc:local:check
 *
 * Is this server ready for the LOCAL analysis provider? Checks the settings
 * (loopback-only Ollama address, pinned model), every model file against its
 * pinned SHA-256, whisper-cli and FFmpeg, and that Ollama on this machine
 * has the pinned vision model (instruct, not "thinking"). Downloads nothing,
 * calls nothing outside this machine, prints check names only.
 */
import { readLocalConfig } from "@/lib/analysis/local/config";
import { checkLocalHealth } from "@/lib/analysis/local/health";
import { loadLocalEnv } from "./lib/env";

async function main() {
  loadLocalEnv();
  const config = readLocalConfig();
  if (!config.ok) {
    console.log(`FAIL  settings: ${config.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Profile: ${config.value.profile}${config.value.profile === "cpu" ? " (testing only — not for designer use)" : ""} · model: ${config.value.visionModel} · Ollama: loopback`);
  const health = await checkLocalHealth(config.value);
  for (const c of health.checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
  console.log(health.ok ? "\nLocal analysis is ready." : "\nLocal analysis is NOT ready.");
  if (!health.ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`Check stopped: ${error instanceof Error ? error.message : "error"}`);
  process.exitCode = 1;
});
