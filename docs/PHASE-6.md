# Phase 6 — Content analysis

> **Local AI provider (2026-10-06):** `QC_ANALYSIS_PROVIDER=local` runs OCR, vision and speech on this server — see [LOCAL-AI.md](LOCAL-AI.md). Mock stays for testing; Google below is optional / future.

How Skybook AI QC reads uploaded content and information files, what it sends where, and how to run, host, test and verify it. Decisions locked 2026-10-04 (D5, D6, D10, confidence policy). Status is in [TRACKER.html](TRACKER.html).

> Skybook AI QC only. Nothing here uses, copies from or integrates with Skybook Audit or New Hive.

## 1. What happens, in order

```
Save and continue / Analyse now / Try again
  → a row in qc_analysis_runs (queued)                     ← the page (server action)
  → the worker claims it (FOR UPDATE SKIP LOCKED)          ← npm run qc:worker
  → re-checks: signed-in owner, active user, company member, session not expired, files unchanged
  → downloads the session's files from the PRIVATE bucket (server to server)
  → prepares them LOCALLY in a per-run temp folder:
       images: sharp (EXIF-rotated, downscaled, re-encoded; the original is never changed)
       PDFs:   MuPDF (WASM, JavaScript off, no network) — pages rendered with page numbers, page caps
       video:  FFmpeg (file protocol only, no network) — sampled frames, duplicate removal,
               audio extraction, measured loudness / true peak
  → calls the provider (at most 3 calls at a time per run):
       Cloud Vision DOCUMENT_TEXT_DETECTION — text, boxes, confidence (measured)
       Gemini 3.8 Flash — labels the OCR blocks (headline / CTA…), fonts, logo, focal point,
                           image issues (AI judgement); speech transcript (video audio only)
  → validates every response against a strict shape (zod), drops anything unexpected
  → assembles ONE ContentDetections object, re-checks access and files, stores it on the run
  → removes the temp folder (finally)
The page polls every 2.5 s, shows progress, then the checks.
```

Information files (6.7) use the same queue (`kind = information`): text is read locally (TXT, DOCX, XLSX, PDF text layer; scanned PDF pages and images by OCR), pattern rules find phones, emails, websites, prices and percentages, then Gemini proposes more. A proposal is kept **only if its value and its quote appear word for word in the file's text**. Every candidate is stored **unconfirmed and optional** ("Needs review", "From uploaded information") and is never used by QC until the designer confirms it.

## 2. Provider (D5)

| | |
|---|---|
| Provider | **Google Cloud** — Cloud Vision `DOCUMENT_TEXT_DETECTION` + Vertex AI **Gemini 3.8 Flash** |
| Region | **EU only.** Vision: `https://eu-vision.googleapis.com/v1/projects/{project}/locations/eu/images:annotate`. Gemini: `https://aiplatform.eu.rep.googleapis.com/v1/projects/{project}/locations/eu/publishers/google/models/gemini-3.8-flash:generateContent`. The global endpoint and every other region are refused by `readGoogleConfig` |
| Interface | `AnalysisProvider` (`src/lib/analysis/provider.ts`) — `readText`, `judgeImage`, `transcribe`, `extractRequirements`, each returning raw text that is validated outside the provider. Swapping providers changes one file |
| Mock | `QC_ANALYSIS_PROVIDER=mock` — every result is labelled **"Sample data — not real AI"** in the panel and the checks |
| Future options | Gemini 3.5 Flash-Lite as a cost fallback (`QC_GEMINI_MODEL`, after testing). Claude only as an interface-level backup — not implemented |
| Gemini settings | strict `responseSchema`, JSON only, `thinkingLevel: LOW`, max 16,384 output tokens; thought parts dropped; blocked or cut-off answers rejected |

### Data retention — REQUESTED / PENDING

- The zero-data-retention / abuse-monitoring exception for this Google Cloud project is **to be requested from Google; status PENDING**. Development does not wait for it.
- **Nothing in this app claims zero retention** until Google confirms the project's eligibility and the exception in writing. Until then: Vertex AI may keep prompts that its abuse monitoring flags (up to 90 days, per Google's documentation), and the 24-hour in-memory cache must be switched off for the project in the Google Cloud console (an operator step, not app code).
- What the app controls: no request or response content is logged; raw provider responses are never stored; only the validated `ContentDetections` is kept, temporarily, on the run row, and it is deleted with the session (24 h after its last change). Only the newest content run keeps detections.
- **Operational item (open):** request the exception, record Google's answer, turn off caching, and only then update this section.

## 3. Video (D6)

- The original video **never leaves the server**. FFmpeg (`ffmpeg-static` 6.1.1, or `FFMPEG_PATH`) runs locally with `-protocol_whitelist file`, `-threads 2` and a 120 s timeout per command.
- Analysed: the first **15 minutes** at most (upload limit stays **50 MB**). Frames every `max(1 s, length ÷ 120)` rounded up to whole seconds → **at most 120 OCR frames**; near-identical neighbours dropped (difference hash + mean colour); up to **8 key frames** judged by Gemini.
- Audio: mono 16 kHz MP3 (32 kbit/s) sent to Gemini for the transcript; loudness (LUFS) and true peak measured locally with `ebur128`.
- Anything not analysed is **NOT VERIFIED**: frames that fail are not filled in; when only part of a video was analysed, "nothing wrong found" passes and sound-level passes become *not verified*.

## 4. Confidence policy (6.9)

| Evidence | Can it fail a design? |
|---|---|
| Measured (OCR text and boxes, pixel colours, contrast, sizes, audio levels, file facts) | Yes — ordinary findings need confidence **≥ 0.80**, CRITICAL **≥ 0.90** |
| "Missing" text (required item, disclaimer) | Also needs **text coverage ≥ 0.90** (coverage = mean OCR page confidence × share analysed) |
| AI judgement (roles, fonts, logo, image quality, speech) | MAJOR / MINOR only when the model says "clear"; **never** a counting CRITICAL — an AI-only critical becomes **"Needs a human check — possible critical issue"** |
| Suggestions | Never block PASS |
| Failed / unavailable / unsupported analysis | **NOT VERIFIED** |
| A PASS that says "nothing wrong anywhere" | Needs coverage ≥ 0.90; otherwise NOT VERIFIED. "It was found" passes and file measurements stand |

The model's "clear / likely / unsure" maps to 0.9 / 0.7 / 0.4. These are **categories, not calibrated probabilities**. The AI never decides severity or the result; there is no PASS / FAIL yet (Phase 7).

## 5. Hosting and the worker (D10)

- **Persistent Node.js host** (not serverless) running two processes from the same code:
  - the app: `npm run build` then `npm run start`
  - the worker: `npm run qc:worker` (keep it running with the host's process manager; restart on exit)
- Queue: PostgreSQL table `qc_analysis_runs` (migration `0006`), `FOR UPDATE SKIP LOCKED`. No Redis, BullMQ, Kafka or other queue service.
- **2 runs at a time per worker**, **3 provider calls at a time per run**, heartbeat every 15 s; a run with no heartbeat for 2 min is queued again, and fails after 3 attempts. One active run per session (unique index). **5 runs per session.**
- Temp files: `QC_WORKER_TEMP_DIR` (default `<os temp>/skybook-qc-runs`), one folder per run, removed in `finally`; the whole folder is swept when the worker starts.
- The host needs: Node 22+, the npm dependencies (`sharp`, `mupdf`, `ffmpeg-static` ship their binaries), outbound HTTPS to Supabase and the two Google EU endpoints, and enough RAM for 2 concurrent runs (an estimate of ~1.5 GB for the worker — not yet measured on a host).

## 6. Settings (server only — never `NEXT_PUBLIC_`)

Put them in `<home>/.skybook-qc/.env.local` (the existing external secrets file) or the host's settings. See `.env.example`.

| Name | Meaning |
|---|---|
| `QC_ANALYSIS_PROVIDER` | `mock` or `google`. Unset → analysis is off and checks say so |
| `QC_MOCK_DELAY_MS` | mock only: pause per call (default 400) so progress is visible |
| `GOOGLE_CLOUD_PROJECT` | Google Cloud project id |
| `GOOGLE_APPLICATION_CREDENTIALS` | path to the service-account key file — **outside the project folder / OneDrive**; never committed, never pasted into chat |
| `QC_GOOGLE_REGION` | `eu` (the only accepted value; default) |
| `QC_GEMINI_MODEL` | default `gemini-3.8-flash` |
| `FFMPEG_PATH` | optional: a system FFmpeg instead of the bundled one |
| `QC_WORKER_TEMP_DIR` | optional: where the worker prepares files |

The Cloud Vision and Vertex AI APIs must be enabled on that project, and the service account allowed to call them (e.g. the Vertex AI User role) — nothing broader.

## 7. Limits (`src/lib/analysis/limits.ts`)

Content files per run 10 · PDF pages 10 per file, 20 per run · video 15 min analysed, 120 OCR frames, 8 judged frames · images sent: OCR long edge 4096 px, judgement 2048 px, ≤ 6.5 MB · information text 60,000 characters, 20 pages per file, 50 candidates per run · timeouts: OCR 20 s, judgement 60 s, transcript 120 s, extraction 60 s, FFmpeg 120 s per command; whole run 5 min (images / PDF) or 10 min (video) · provider responses ≤ 10 MB, JSON depth and item counts capped · 2 retries per call (2 s, 6 s + jitter; Retry-After honoured up to 30 s); one retry for an invalid answer.

## 8. Cost (rough, per run)

- Image / PDF page: 1 Vision call + 1 Gemini call each. Video: up to 120 Vision calls + up to 8 Gemini calls + 1 transcript call (≤ 15 min of audio). Information file: 1 Gemini call (+ Vision for images / scanned pages).
- Gemini 3.8 Flash on the EU endpoint: **$0.825 / 1M input tokens and $4.125 / 1M output tokens until 31 Dec 2026, then $1.65 / $8.25** (Google's published price, checked 2026-10-04). Vision is billed per image (see Google's Cloud Vision pricing page).
- The 5-runs-per-session cap and the frame caps bound the worst case. Set a budget alert on the Google Cloud project.

## 9. Security

- Google credentials and keys: server only, from the external secrets file / host settings; never `NEXT_PUBLIC_`, never in the browser bundle (verified by scanning `.next/static`), never printed.
- Files stay in the private `qc-temp-files` bucket; the worker downloads them with the service key. No public or signed download URLs are given to any provider — only prepared bytes.
- Uploaded text is untrusted data: prompts wrap it in `<data>` markers and tell the model it is never instructions; the model can only label OCR blocks it was given (unknown ids are rejected) and cannot add text; extraction proposals must be quotes from the file.
- The worker re-checks the requester, membership, ownership and expiry before and after processing; changed files cancel the run.
- No QC history: runs and detections cascade-delete with the session.

## 10. Testing

| What | How |
|---|---|
| Normal suite (no live AI) | `npm test` — mock provider, recorded Vision / Gemini responses, fake HTTP, PGlite, fake bucket, real sharp / MuPDF / FFmpeg on generated media |
| Real-provider smoke test (opt-in, billable) | `npm run qc:smoke:google -- --yes-call-google` — one Vision and one Gemini call on a synthetic image; prints PASS / FAIL and counts only. Refuses without the flag |
| Try it locally with the mock | set `QC_ANALYSIS_PROVIDER=mock`, run `npm run dev` and, in a second terminal, `npm run qc:worker`. Name a file `…mock-fail…`, `…mock-retry…`, `…mock-malformed…` or `…mock-slow…` to see those paths |

## 11. Known limitations

- Real Google calls have **not** been verified yet (no credentials configured); the provider is tested against recorded responses only.
- Old `.doc` / `.xls` information files aren't read (the designer is told to save as DOCX / XLSX or type the requirements).
- Video sampling is at least 1 s apart; very short on-screen text can be missed (it is then not detected, never invented). Only the first 15 minutes are analysed.
- Fonts, roles, logo identity and image issues are AI judgements and can be wrong; they never fail a design on their own at CRITICAL level.
- An image with no text gives zero text coverage, so "missing text" and "nothing wrong" checks stay not verified for it.
- PDF pages beyond the caps are not analysed (coverage reflects this).
