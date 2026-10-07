# Local AI provider

`QC_ANALYSIS_PROVIDER=local`: content is analysed **entirely on this server**. There are no AI API calls and no API billing. The mock stays available for testing, and Google remains an optional future provider. This builds on [PHASE-6.md](PHASE-6.md): the same queue, worker, validators, detections contract and confidence policy are used.

> Skybook AI QC only. Nothing here uses or integrates with Skybook Audit or New Hive.

## 1. What runs where

| Step | Local engine | Notes |
|---|---|---|
| Reading text (OCR) | **PaddleOCR PP-OCRv6 tiny** through ONNX Runtime (`ppu-paddle-ocr` 6.6.0, `onnxruntime-node` 1.30.0), inside the worker | Plus a **second read** of every line (up to 60 per image) by PP-OCRv5 English on the line's crop |
| Visual judgement and requirement extraction | **Qwen3-VL 4B instruct** in **Ollama**, on `127.0.0.1` only | Strict JSON schema (`format`), temperature 0, thinking off, 4,096-token context and 800-token answers for judgements |
| Speech | **whisper.cpp** (`whisper-cli`) | `ggml-base.en` (English only) |
| Images, PDF pages, video frames, audio, loudness | Unchanged: sharp, MuPDF, FFmpeg | |

`LocalProvider` (`src/lib/analysis/local/local-provider.ts`) implements the existing `AnalysisProvider` interface. Every answer goes through the existing strict validators. For OCR, the new `validateLocalOcr` produces the same `OcrResult` as Vision.

## 2. Safety rules (Local only; Google and the mock are unchanged)

| Rule | Why (the 2026-10-06 trial) |
|---|---|
| A local OCR line counts at full confidence only if the **second read agrees**; otherwise it is capped at **0.89**, below the 0.90 bar a CRITICAL needs | Two real misreads scored ≥ 0.90 ("Istand Hopping", "THEGRANDTO∪R"). The second read caught both |
| Text the second read **didn't confirm** never makes a counting finding at **any** severity; it becomes "Needs a human check". The second read also compares word breaks ("EarlyBird" ≠ "Early Bird") | The 2026-10-06 acceptance run: misreads made 5 false MAJORs before this rule and 0 after |
| A text-based **CRITICAL** needs confidence **≥ 0.95** | OCR confidence alone never creates a CRITICAL |
| "Missing" text is **never a local CRITICAL**; it becomes "Needs a human check — possible critical issue" | Local OCR can't measure what its detector missed (vertical, overlapping or pixelated text) |
| An AI "no problem found" pass (image quality, colour-only meaning, brand fonts, headline stands out) is **NOT VERIFIED** | The 4B model missed a blurred design |
| AI-only evidence never makes a counting CRITICAL; partial analysis stays NOT VERIFIED; the analysed share is kept | Unchanged Phase 6 rules |

## 3. Privacy

- **Ollama is loopback only.** `QC_LOCAL_OLLAMA_URL` must be `http://127.0.0.1:<port>` (or `localhost`, or `[::1]`), and the client re-checks the address on every request. It uses plain `node:http` — no `https`, no `fetch`; a test enforces this.
- **Cloud models are refused.** Any model name containing `cloud` is rejected. Run Ollama with `OLLAMA_NO_CLOUD=1` and `OLLAMA_HOST=127.0.0.1:11434`.
- **No downloads at run time.** OCR models are read from local files and handed over as bytes, so the library never fetches. Every model file is checked against a **pinned SHA-256**, and the vision model against its **pinned Ollama digest**.
- **Raw output never leaves memory.** Raw model output is never logged or stored; only the validated `ContentDetections` is kept, temporarily, as before. Audio and OCR crops live in the run's private temp folder, which is always removed.
- **Operator step:** block outbound traffic for `ollama.exe` / `llama-server.exe` in the host firewall.

## 4. Settings (server only; none are secrets)

```
QC_ANALYSIS_PROVIDER=local
QC_LOCAL_PROFILE=cpu            # cpu = testing only (minutes per design); gpu = production target
QC_LOCAL_OLLAMA_URL=http://127.0.0.1:11434
QC_LOCAL_VISION_MODEL=qwen3-vl:4b-instruct
QC_LOCAL_MODELS_DIR=C:\skybook-qc-local-models     # ocr\ and whisper\ — outside the project / OneDrive
QC_LOCAL_WHISPER_BIN=C:\skybook-qc-local-models\whisper\bin\whisper-cli.exe
QC_LOCAL_WHISPER_MODEL=ggml-base.en.bin
QC_LOCAL_THREADS=4
QC_LOCAL_MIN_FREE_MB=512        # skip an AI call (→ not verified) when free RAM is lower
# For a model or whisper file that isn't pinned: QC_LOCAL_VISION_MODEL_DIGEST, QC_LOCAL_WHISPER_MODEL_SHA256
```

Required files in `QC_LOCAL_MODELS_DIR` (checked by SHA-256):
- `ocr/`:
  - `PP-OCRv6_tiny_det.ort`, `PP-OCRv6_tiny_rec.ort`, `ppocrv6_tiny_dict.txt` (main read);
  - `PP-OCRv5_mobile_det_infer.ort`, `en_PP-OCRv5_mobile_rec_infer.ort`, `ppocrv5_en_dict.txt` (second read).
- `whisper/`: `ggml-base.en.bin`.

In Ollama: `qwen3-vl:4b-instruct`, digest `ee4b975b…`. **Never use the plain `qwen3-vl:4b` / `8b` tags.** They are "thinking" models; in the trial one ran 17 minutes on a single design and returned nothing. The health check refuses them.

## 5. Running it

```
npm run qc:local:check                          # settings, checksums, Ollama model — downloads nothing
npm run qc:worker                               # prints the same checks at start; 1 run, 1 model call at a time
npm run qc:smoke:local -- --yes-run-local       # opt-in: real models on a synthetic design (minutes on CPU)
```

If the health check fails, runs fail with a plain reason ("Local analysis isn't set up on this server (…)"). The page labels runs and results **"Local AI — runs on this server"**, and warns that local analysis can take several minutes per design.

## 6. Limits (`LOCAL_LIMITS` in `src/lib/analysis/limits.ts`)

| | `cpu` (testing only) | `gpu` (production target, to confirm) |
|---|---|---|
| Runs at a time / model calls per run | 1 / 1 | 1 / 1 |
| Judge image long edge | 1,024 px | 1,024 px |
| Designs judged by AI per run (the rest: OCR and measurements only, AI checks NOT VERIFIED) | 3 | 10 |
| Video key frames judged | 3 | 8 |
| Timeouts: OCR / judgement / transcript / extraction | 30 s / 600 s / 600 s / 600 s | 30 s / 120 s / 300 s / 120 s |
| Whole-run cap: images / video | 30 min / 30 min | 10 min / 15 min |
| Retries | 1, connection errors only (a timed-out call is not repeated) | Same |
| Stale-run takeover | after 15 min | after 5 min |
| Extraction text | 12,000 characters | 30,000 characters |

The file, page, video, frame and run-per-session caps are the same as for every provider.

## 7. Measured on this PC (i7-4790, 8 GB RAM, no GPU)

| | Result |
|---|---|
| OCR + second read | ~0.5 s per design (8.5 s for the first, while models load) |
| Vision judgement (4B) | 239–310 s per design in the trial; 162 s in the smoke test; a full real run took **186 s** for one design |
| Memory | Model server peaked at 4.9 GB, leaving free RAM as low as 28 MB |
| Video (60 s, 1 key frame) | 2 min 42 s |

**This PC is not suitable for designer use.** The `cpu` profile exists for development and testing only.

## 8. Acceptance status (2026-10-06)

The GPU acceptance benchmark **could not be run**. This PC has no NVIDIA GPU (Intel HD 4600, no CUDA), and Ollama reports CPU only, with 0 B of VRAM.

The parts that don't need a GPU were run on all 25 designs through the real local OCR, the rules and the local policy (results in `skybook-local-ai-trial/results/acceptance-ocr.json`):

| Criterion | Result |
|---|---|
| OCR valid output | 25 / 25 |
| OCR character accuracy (≥ 90%) | **93.0%** — pass |
| Counting CRITICALs from OCR (0 false) | **0** — pass; 7 possible criticals correctly sent to a human check |
| False MAJORs from misreads | 5 → **0** after the rule above |
| OCR time | 0.63 s per design |

**Not measured, because they need a GPU:** vision output validity on all 25 designs, ≤ 30 s per design, and free RAM ≥ 1 GB with the model loaded. On this CPU the trial measured 239–310 s per design and free RAM down to 28 MB, so this PC fails those criteria.

## 9. Before production (not done yet)

1. **GPU acceptance benchmark on the target machine** (NVIDIA, 12–16 GB VRAM, 32 GB RAM). Run the 25-design answer key from the trial and pass:
   - OCR character accuracy ≥ 90%;
   - 100% valid output;
   - 0 false counting CRITICALs;
   - ≤ 30 s per design;
   - free RAM never below 1 GB.

   Then confirm or adjust the `gpu` limits.
2. Test on **real client designs**, including Arabic. The trial set was synthetic and in English, and `ggml-base.en` is English only, so add a multilingual whisper model with its checksum.
3. Install Ollama as a service on the host with `OLLAMA_HOST=127.0.0.1:11434`, `OLLAMA_NO_CLOUD=1`, `OLLAMA_NUM_PARALLEL=1` and `OLLAMA_MAX_LOADED_MODELS=1`, plus the firewall rule above.
4. Optionally, pin the 8B instruct model by digest for the GPU host.
