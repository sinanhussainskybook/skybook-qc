# Skybook AI QC — Architecture

## Standalone

Skybook AI QC is a standalone application. It has **no dependency on, and no integration with, Skybook Audit** or any other Skybook project:

- no shared code, configuration or business logic
- no shared database or data, and no connection to another project's database
- no API calls between the projects

## Saved data vs temporary QC sessions

The app keeps two kinds of data, and never mixes them:

```
 SAVED — Supabase PostgreSQL (D1) + logo files in     TEMPORARY — one QC session (D11)
         Supabase Storage (D3)                         rows qc_sessions / qc_requirements / qc_files
                                                       + files in the private qc-temp-files bucket
 ┌───────────────────────────────────────┐            ┌───────────────────────────────────────┐
 │ User accounts + sign-in sessions      │            │ Content type                          │
 │ Companies                             │   read     │ Requirements for this check           │
 │ Company info, contact, website,       │ ─────────▶ │ Uploaded information files            │
 │   address                             │   only     │ Content being checked                 │
 │ Logos                                 │            │ Findings, scores, result (Phase 5–7)  │
 │ Brand guidelines                      │            │ Report (built on download, Phase 8)   │
 │ Golden Rules (brand / QC config)      │            │                                       │
 └───────────────────────────────────────┘            └───────────────────────────────────────┘
   kept for every future QC session                      deleted 24 h after the last change
```

- A QC session **reads** company information but never changes or copies it.
- **Golden Rules** are saved with each company's brand guidelines and edited on the company page. When a company is selected for a QC session, its active Golden Rules are loaded and applied automatically — the designer does not re-enter them.
- Session data is **temporary** (D11): held as database rows and files only while the designer works, and **deleted automatically 24 hours after the session's last change** (or on Start over). One current session per designer per company. No QC history, previous results, stored reports, recent uploads, design library or asset library.
- Only `lib/db/` talks to the database.

## QC sessions (Phase 4 — Requirements + Upload, D11)

| Table | Holds |
|---|---|
| `qc_sessions` | company, designer, content type (`design_poster` / `social_post` / `reel_short` / `youtube_video`), status (`draft` / `ready`), `expires_at`. Unique per (company, designer) |
| `qc_requirements` | type (an open `lower_snake` key — the list lives in `lib/qc/requirements.ts`, so new types need no migration), optional label, expected value, notes, mandatory, confirmed, source (`manual` / `extracted`), optional source file |
| `qc_files` | kind (`information` / `content`), display name, storage path `{session_id}/{file id}.{ext}` (checked by the database to be inside its own session's folder), type, size, status (`pending` / `ready`) |

All three cascade from the session; sessions cascade from their company and user. Row-level security on, no policies.

**Who may use a session** (`lib/qc/access.ts`, reusing the D13 company rules): signed in → the session exists, hasn't expired and **belongs to this designer** (nobody else, admins included) → the designer may still open its company. Anything else is "not available" — the same answer for a forged ID, another designer's session, an expired one, or a company you left.

**Uploads** (`lib/qc/session.ts`, `lib/qc/qc-file.ts`) go straight from the browser to Storage, never through the app server:

```
browser: quick check (type, size)
server:  check request (area, content type, extension, declared type, size, file count)
         → create a pending record with a server-made path → one-time signed upload link
browser: PUT the file to that link (Supabase Storage)
server:  read the first 64 KB + real size back from Storage → must be that format and within the limit
         → ready (or: delete the file and the record, and explain why)
```

- Formats are recognised from their first bytes: PDF, DOC/XLS (OLE), DOCX/XLSX (ZIP with the right Office parts; macro-enabled files refused), TXT (plain text, no binary), JPG, PNG, WEBP, MP4/MOV (`ftyp`), WEBM (EBML + `webm`).
- Upload Information: PDF, DOC, DOCX, XLS, XLSX, TXT, JPG, PNG, WEBP (up to 10). Upload Content follows the content type: images + PDF for Design / Poster and Social Media Post (up to 10), MP4 / MOV / WEBM for Reel and YouTube (one). 25 MB per file (`MAX_UPLOAD_MB`), **50 MB for video** — the Supabase Free plan's maximum.
- Unfinished uploads are cleared after an hour. The app never opens, runs or serves these files as web pages.

**Deletion.** `purgeExpiredSessions` runs whenever someone opens Start QC, and `npm run qc:cleanup` can run on a schedule (D10). It deletes the session's whole Storage folder first, then the rows; if Storage can't be reached the session is kept and retried, so no file is left unreferenced.

**The QC engine's input** (`lib/qc/qc-input.ts`, `loadQcInput`): one object — the company's saved configuration from the existing `loadCompanyConfiguration` (not copied) + content type + **confirmed** requirements only + information files + content files. Unconfirmed requirements are only counted.

**Verified on the real Supabase project (2026-10-01):** signed upload links (browser → Storage), the read-back check, rejection and deletion of disguised files, upload links that can't be reused or pointed elsewhere, private bucket (no public, keyless or anonymous access), one session per designer per company, persistence across reloads, and expiry clean-up of rows and files.

**Deferred on purpose:** reading text out of uploaded information and finding requirements in it (plan 4.5–4.6, now Phase 6 task 6.7) come with the extraction work — the data model (`source = extracted`, unconfirmed, "Needs review") is ready; nothing is extracted yet. Platform sizes (4.3) were built in Phase 5 (below).

## QC engine and Platform / Size (Phase 5, first round — D4)

**One finding shape** (`lib/qc/findings.ts`): every rule in every category reports `Finding`s: category (9), severity (critical / major / minor / suggestion), status (passed / failed / unverified / not applicable), kind (fact / judgement), expected, detected, explanation, suggested fix, confidence, file, source. A `Rule` says which content types it applies to and what it needs. `lib/qc/engine.ts` (`runRules`) runs the rules for the session's content type and sorts the findings. Nothing here scores or decides PASS / FAIL (Phase 7).

**Platform values (D4)** live in `lib/qc/platforms.ts` — one table of platforms → placements, each with its published source link. Website banner, Email banner, Print, Presentation slide and Other have no official spec, so the designer types the required size (`px`, or `mm` + optional DPI). `lib/qc/platform-choice.ts` validates a choice against that table and the content type's media (images vs video).

**Database (migration 0005)** — no new tables; the existing temporary ones gain columns, so ownership, expiry and clean-up are unchanged:

| Table | New columns |
|---|---|
| `qc_sessions` | `platform`, `placement` (keys, `lower_snake`), `custom_label`, `custom_width`, `custom_height`, `custom_unit` (`px` / `mm`), `custom_min_dpi`, `custom_max_bytes`. Checks: a placement needs a platform; a custom size has width, height and unit together |
| `qc_files` | `media_width`, `media_height`, `media_duration_ms`, `media_dpi`, `media_pages`, `media_note` (why something couldn't be measured) — numbers only, never the file |

**Measuring** (`lib/qc/media-info.ts`): when a content upload is confirmed, its real size is read from the file's own structure — PNG (IHDR, pHYs DPI), JPG (SOF, JFIF density, EXIF orientation → measured upright), WEBP (VP8 / VP8L / VP8X), PDF (first `/MediaBox` in points, `/Rotate`, page count), MP4 / MOV (`mvhd` length, `tkhd` size, rotation matrix), WEBM (EBML: duration, pixel size). The 64 KB already read is used when enough; otherwise (e.g. a video whose `moov` is at the end) the whole file is read once. Anything unreadable is recorded as a note and the checks report it as **not verified**.

**Checks** (`lib/qc/rules/platform-size.ts`): format, file size (platform limit — separate from the storage limit), aspect ratio (published tolerance → MAJOR; recommended-only → SUGGESTION), min / max / exact size, recommended resolution (SUGGESTION), length, YouTube Shorts orientation, LinkedIn video ratio list, print DPI at the typed size, PDF page size ±1 mm. Safe zones are shown with their spec but **not verified** until Phase 6 can see where text sits. No text rules (no OCR yet).

**Screen:** Start QC gains **2. Platform** (platform → placement, or the size fields, with a "What will be checked" summary and source link) and, once content is uploaded, a **Platform check** section listing issues as Expected / Detected / Issue / Suggested fix, then not-verified items, then passed checks. Changing between image and video content clears the platform. Ready needs a platform.

**Verified on the real Supabase project (2026-10-01):** migration 0005 applied; platform choice saved and read back; real constraints refuse inconsistent rows; a real PNG and a real MP4 (details after 64 KB) uploaded through signed links and measured; findings correct; expiry clean-up; all temporary data removed (before / after snapshots identical).

## QC rules — all nine categories (Phase 5, round 2)

**Two inputs, one engine.** `QcContext` (`lib/qc/rules/context.ts`) = approved information (company configuration via `loadCompanyConfiguration`, **confirmed** requirements, platform choice, measured files — built by `toQcInput` / `qcContextOf`) + **detections** (`lib/qc/detections.ts`: text with position / size / colour / timing, speech, colours, fonts, logo, focal point, image issues, colour-only meaning, audio). `QC_RULES` (`lib/qc/rules/index.ts`) lists every rule; `runRules(QC_RULES, contentType, context)` runs those that apply to the content type — video checks are just rules that apply to Reel / Short and YouTube. **Start QC currently offers only the static types** (`OFFERED_CONTENT_TYPES`, checked by the start / change actions); the video types, rules and analysis are kept for later.

**Detections are `null` in the app until Phase 6** (OCR / visual / video analysis, D5 / D6). Every check that needs them reports **not verified** with one explanation, and the page says so once. Tests supply fixture detections — the Phase 5 "done when". A missing field means "not analysed"; an empty list means "analysed, nothing found". `source: "fixture" | "mock" | "ai"` keeps a mock from being mistaken for real analysis.

**Comparison helpers** (`lib/qc/compare.ts`, 5.3) do all matching: words ignoring case / punctuation, close misspellings (Damerau–Levenshtein, 0 / 1 / 2 edits by length), phones (a local form matches the international one but is flagged), prices (currency + amount), percentages, dates (ambiguous numeric dates keep both readings), times, emails, websites, CTAs, WCAG contrast, colour difference (ΔE), neutrals, font families.

| Category | Rules (file) | Severity when failed |
|---|---|---|
| Content (5.4) | contact details vs saved / brief · company name spelling · placeholder text · repeated word (`content.ts`) | wrong contact CRITICAL (no country code MINOR) · MAJOR · CRITICAL · MINOR |
| Brand (5.5) | brand colours used · text colours · fonts · banned / misspelt terms · logo · written guidelines (`brand.ts`) | MINOR · MINOR · MAJOR · MAJOR · missing MAJOR, wrong logo CRITICAL · listed, not verified |
| Golden Rules (5.6) | every active saved rule: disclaimer, product name, CTA, colour, font; worded rules listed (`golden-rules.ts`) | mandatory CRITICAL, optional MAJOR |
| Design & Layout (5.7) | overlap · edge margin · headline largest · Rule of Thirds · on-screen time (video) (`layout.ts`) | MAJOR · MINOR · **SUGGESTION** (judgement) · **SUGGESTION** (judgement) · MINOR |
| Accessibility (5.8) | contrast · text size · colour-only meaning · captions (video) (`accessibility.ts`) | MAJOR · MINOR · MINOR · MINOR |
| Image & Asset (5.9) | watermark · blur / pixelation / stretching · cut off · sound (video) (`image-asset.ts`) | CRITICAL · MAJOR · MINOR · none SUGGESTION, clipping MINOR, loudness SUGGESTION |
| Brief (5.10) | each confirmed requirement · unexpected prices / percentages / dates (`brief.ts`) | missing: mandatory CRITICAL / optional MINOR · wrong: CRITICAL / MAJOR · mismatched MAJOR · unexpected MAJOR / MINOR |
| Platform / Size (5.11) | round 1 (`platform-size.ts`); safe zone now checks text / logo positions when available | per D4 |
| Legal (5.12) | disclaimers in the confirmed brief, word for word, on screen (`legal.ts`) — nothing else invented | mandatory CRITICAL, optional MAJOR |

Severities live in each rule (`defaultSeverity` and the finding it builds), so they can be changed without touching screens; thresholds (contrast 4.5 / 3, text 1.5 % of the shorter side, edge 2 %, thirds 10 %, colour ΔE 10, audio −1 dBFS / −20…−9 LUFS, reading 300 ms per word, minimum 1.5 s) are named constants beside the rules. Findings based on a detection carry its confidence; under 0.8 they are worded as a **judgement**. Subjective checks are always judgements, whatever the confidence.

### Phase 5 freeze (2026-10-01)

**Status: FROZEN / COMPLETE.** Phase 5 *defines* the QC rule engine; it does not read content. The rules consume structured detections, which Phase 6 will supply (OCR, vision, video / audio — D5, D6). Until then every non-platform check in the live app is **not verified**. No Phase 6 code exists.

**Severity model:** CRITICAL / MAJOR / MINOR / SUGGESTION, unchanged. **Result model (Phase 7, task 7.4, thresholds per D7, not built yet):** any failed CRITICAL → FAIL; else any failed MAJOR or MINOR → NEEDS REVISION; else PASS. A SUGGESTION never blocks PASS. **Only findings with status `failed` count.** Passed, not-verified and not-applicable findings still carry the severity they *would* have (for display), but never count. Tests in `rules/all-rules.test.ts` pin this input down with the plan's rule as an oracle.

**Objective vs subjective.**
- **Objective** (deterministic once the detection exists; a fact unless the detection is unsure): contact details, company-name spelling, placeholder text, repeated words, banned / misspelt terms, brand fonts, text colours vs palette, logo present / identity, every Golden Rule with an approved value, overlap, edge margin, contrast (WCAG), text size, captions coverage, on-screen time, watermark / pixelated / stretched / blurry / cut-off (as reported by the detector), audio peak / loudness, every Brief and Legal check, all of Platform / Size.
- **Subjective** (always a judgement, never more than SUGGESTION unless the plan says otherwise): Rule of Thirds, headline hierarchy. Colour-only meaning is an interpretation, so always a judgement, but it stays MINOR because plan 5.8 names it as an accessibility rule. Written brand guidelines (tone, capitalisation…) and worded Golden Rules are never auto-decided: they are listed as not verified for a person.

**Changes made in the freeze review:**
- Headline hierarchy is now SUGGESTION + judgement (it was MINOR).
- Rule of Thirds and colour-only meaning are always judgements.
- Two false positives fixed. Both would have produced a CRITICAL "wrong contact": a year range ("2025 - 2026") read as a phone number, and "St.Regis" / "Dubai.Today" read as websites. A bare word.word now needs `https://`, `www.` or a known domain ending.
- Per-file frame sizes added to the contract (carousels).

**Severity notes for D7 / later review (not changed):**
- A wrong contact detail is CRITICAL even when a legitimate partner number appears. The brief can list it to make it expected.
- A bare 7–15 digit number (e.g. a plot number) is still read as a phone number.
- "Unexpected" offer details are MINOR when the brief gives none of that kind.
- On-screen reading time (300 ms per word) and the text-size, edge and audio thresholds are app settings, not published standards.
- Phase 7 should show how much was actually verified, so that a session with everything not verified isn't presented as a plain PASS.

### Phase 5 → Phase 6 contract (`lib/qc/detections.ts`, `ContentDetections`)

Phase 6 fills ONE object per session and passes it to `qcContextOf(input, detections)`. Everything else (company configuration, confirmed requirements, platform, measured width / height / length / DPI) is already loaded by Phase 5. A missing field = not analysed (→ not verified); an empty list = analysed, nothing found.

| Area | Field | What Phase 6 provides |
|---|---|---|
| Origin | `source` | `"ai"` (or `"mock"`, always labelled sample data — 6.2) |
| Frames | `frame` / `frames[]` | analysed frame size in px; per file (`fileId`) when sizes differ |
| Text (OCR, 6.4) | `texts[]` | `text`, `fileId`, `box` (fractions 0–1), `role` (headline / body / cta / disclaimer / other), `fontFamily`, `fontSizePx`, `bold`, `color` + `background` (#rrggbb), `startMs` / `endMs` for video, `confidence` |
| Speech (6.6) | `speech[]` | transcript segments `text`, `startMs`, `endMs`, `confidence` |
| Brand (6.5) | `colors[]`, `fonts[]` | dominant colours with `share`; font families with `confidence` |
| Logo (6.5) | `logo` | `present`, `matchesCompanyLogo` (compared with the saved logo), `box`, `confidence` |
| Layout (6.5) | `focalPoint`; text `box`es | main subject position; overlap, edges, hierarchy and safe zones are computed by Phase 5 from the boxes and sizes |
| Images (6.5) | `imageIssues[]` | `issue` (watermark / blurry / pixelated / stretched / cut_off), `fileId`, `confidence`, `note` |
| Accessibility (6.5) | `colorOnlyMeaning` | `present`, `confidence`, `note` |
| Audio (6.6) | `audio` | `hasAudio`, `integratedLufs`, `peakDbfs`, `confidence` |

**Not needed from Phase 6:** phone numbers, emails, URLs, prices, percentages, dates, times and CTAs are pulled out of `texts` / `speech` by the Phase 5 helpers (`compare.ts`). Video duration and resolution come from the file measurement (Phase 5). Colours, fonts and the logo are one set for the whole content, not per file. Per-file brand checks would be a later contract change.

**On screen:** once content is uploaded, Start QC shows **Content checks** — each category with its counts, expandable to what is checked (expected values included). No score and no PASS / FAIL (Phase 7).

**Forms keep what was typed.** React resets a `<form action={…}>` after every action, even a refused one; the requirement and platform forms submit through `submitKeepingValues` (`components/qc/submit-keeping-values.ts`) instead, covered by jsdom tests (`components/qc/form-values.test.tsx`).

**Verified on the real Supabase project (2026-10-01, round 2):** no migration needed; the full rule set read a temporary company's real saved brand and Golden Rules, real confirmed requirements (unconfirmed ones excluded) and a real measured upload; with fixture detections the same real data produced the expected CRITICAL / MAJOR findings; browser flow checked; temporary data removed; the real company, its configuration and the admin user fingerprint-identical before and after.

## Content analysis (Phase 6 — D5 / D6 / D10)

Full detail: [PHASE-6.md](PHASE-6.md).

- `lib/analysis/` — provider interface (`provider.ts`), mock and Google providers (`mock-provider.ts`, `google/`), strict response validation (`validate.ts`), assembly into ONE `ContentDetections` (`assemble.ts`), the confidence policy (`policy.ts`, applied to the Phase 5 findings), provider calls with timeouts / retries (`call.ts`), local media preparation (`media/`: sharp, MuPDF, FFmpeg), the run pipeline and worker (`pipeline.ts`, `worker.ts`), information-file extraction (`documents.ts`, `information.ts`), limits (`limits.ts`).
- `lib/db/analysis-runs.ts` + migration `0006_qc_analysis_runs.sql` — the PostgreSQL queue: one row per run (`content` or `information`), status / stage / progress / heartbeat, the validated detections (newest content run only), cascade-deleted with the session. RLS on, no policies (server role only). One active run per session (partial unique index).
- Processes: the Next.js app enqueues and polls; `npm run qc:worker` processes (2 runs at a time, 3 provider calls per run). Persistent Node host — not serverless.
- Google Cloud **EU** endpoints only (Vision `eu-vision.googleapis.com`, Gemini `aiplatform.eu.rep.googleapis.com`), Gemini 3.8 Flash. Zero-retention exception REQUESTED / PENDING.
- **Approved additive changes to the frozen Phase 5 contract (2026-10-04):** `DetectedText.page` and `frames[].page` (multi-page PDFs), `textCoverage`, and `QcContext.analysis` (not configured / not started / pending / done — with the analysed share — / failed / unsupported) for the not-verified wording. No Phase 5 rule changed; colour confidence stays as measured.

### Local AI provider (2026-10-06)

`QC_ANALYSIS_PROVIDER=local` — `lib/analysis/local/`: `config.ts` (loopback-only Ollama, pinned models), `health.ts` (SHA-256 / digest checks, no downloads), `ocr.ts` (PaddleOCR via ONNX + an independent second read per line), `ollama.ts` (node:http to 127.0.0.1 only), `whisper.ts` (whisper-cli child process), `local-provider.ts`. Shared prompts moved to `lib/analysis/prompts.ts` (Google re-exports them). Per-provider limits (`limitsFor`, `LOCAL_LIMITS.cpu/gpu`), and local-only policy rules in `policy.ts` (`{ provider: "local" }`). Migration `0007_qc_local_provider.sql` allows `provider = 'local'`. The web app never imports the local engines (only the worker does). Details: [LOCAL-AI.md](LOCAL-AI.md).

## Score and result (Phase 7)

`lib/qc/scoring.ts` reads the findings AFTER the confidence policy and never re-judges them. Only `failed` findings count: any counting CRITICAL → FAIL; otherwise any MAJOR / MINOR → NEEDS REVISION; otherwise PASS. Suggestions, not verified checks and "Needs a human check" never count, so AI uncertainty can't fail a design (the policy already made it unverified). No answered check → no result. Score: each category with an answered check starts at 100 and loses 40 / 15 / 5 / 0 per critical / major / minor / suggestion (`SCORE_WEIGHTS`, D7 to confirm); overall = their average. Shown by `components/qc/scoreboard.tsx` in the "QC result" section once the content is analysed; computed from the current session each time — nothing is stored.

## QC report (Phase 8, D8)

`GET /companies/[companyId]/qc/report` (route handler) builds the PDF from the designer's CURRENT session on each download — same checks as the Start QC page (signed in, company access, the session's owner); 409 until there is a result. `lib/qc/session-result.ts` computes findings and the Phase 7 result once for both the page and the report, so they always agree. `lib/report/report-data.ts` turns them into report data; `lib/report/report-pdf.ts` draws an A4 PDF with **pdf-lib** (pure JavaScript, no native parts); `lib/report/report-logo.ts` reads the saved logo server-side from the private bucket and converts it with sharp (missing or damaged → name only). Nothing is stored: no row, no file, no history; `Cache-Control: private, no-store`.

**Fonts (8.1):** `lib/report/report-fonts.ts` embeds **Noto Sans (Latin, Latin Extended) + Noto Sans Arabic** (SIL OFL 1.1, from the `@fontsource` packages; WOFF unpacked to TrueType by `woffToSfnt`) in full, via `@pdf-lib/fontkit`. Arabic is joined by `shapeArabic` (Unicode presentation forms, lam-alef ligatures) and font-level shaping is switched off, because pdf-lib records glyph widths but not mark positions. Word order: Arabic phrases inside an English line read right to left; a line with Arabic and no Latin letters is reversed whole (no full Unicode bidi). A character no font has prints "?"; if the fonts can't load, Helvetica is used as before. **Time zone:** Asia/Dubai by default (`QC_REPORT_TIME_ZONE`).

## Gemini API provider (2026-10-06)

`QC_ANALYSIS_PROVIDER=gemini` — `lib/analysis/gemini/` (`config.ts`: `GEMINI_API_KEY`, `QC_GEMINI_MODEL` default `gemini-3.8-flash`; `gemini-provider.ts`). One `generateContent` call per design (`analyzeDesign`, optional on `AnalysisProvider`; the pipeline uses it when present and passes `designContextOf` — confirmed requirements + saved rules). `validateDesignAnalysis` splits the answer into the usual OcrResult + ImageJudgement, so assembly, rules, scoring and the report are unchanged. Policy profile `{ provider: "gemini" }`: everything Gemini reports is AI evidence (no counting CRITICAL; MAJOR / MINOR only when clear; AI "no problem" passes not verified); Platform / Size stays measured. Migration `0008_qc_gemini_provider.sql`. No Vertex AI, Cloud Vision or billing. Details: [GEMINI.md](GEMINI.md).

## Secrets location

The project folder is synced by OneDrive, so secrets live **outside** it, in `<home>/.skybook-qc/.env.local`. `src/lib/external-env.ts` loads that file with Node's built-in reader from `next.config.ts` (dev, build, start) and `scripts/lib/env.ts` (every `npm run` script). It never overwrites a value that is already set — Next.js reads a project `.env.local` first, so that one wins — never prints anything, and skips a missing file. No secret has a `NEXT_PUBLIC_` name, so none is sent to the browser. Verified with harmless values in dev, production start and the scripts, and by scanning `.next/static`. On a host (D10), the same names are set in the host's settings instead.

## Database (D1 — Supabase PostgreSQL)

- QC has its **own** Supabase project. The app connects with a PostgreSQL connection string in `DATABASE_URL` (server-only, in the secrets file above or the host's settings — never in code, never `NEXT_PUBLIC_`). Nothing connects until the first query, so the app builds without it.
- The app talks plain SQL through the `postgres` driver. It does **not** use Supabase Auth or the Supabase browser client: the browser never talks to the database.
- Every table has **row-level security switched on with no policies**, so Supabase's public Data API (anon / authenticated keys) can read nothing. Only the server's own connection can.
- Schema changes are numbered SQL files in `db/migrations/`, applied in order by `npm run db:migrate` and recorded in `schema_migrations`.

| Table | Holds | Phase |
|---|---|---|
| `app_users` | id, name, email (unique, lower-case), password_hash, role (`admin` / `designer`), active, created / updated | 2 |
| `app_sessions` | SHA-256 hash of the sign-in cookie token, user, created, expires. Deleted on sign-out; expired rows cleaned up | 2 |
| `login_throttle` | failed sign-in counter per email, per 15-minute window. Cleared on success | 2 |
| `companies` | name, description, category, country, city, address, active, created_by, created / updated | 3 |
| `company_members` | (company, user) pairs — who may open which company (D13) | 3 |
| `company_contacts` | one row per company: phone, WhatsApp, email, website | 3 |
| `brand_profiles` | one row per company: tone, capitalisation rules, naming conventions, logo rules, template notes, other guidelines | 3 |
| `brand_colors` | many per company: name, HEX, optional CMYK, usage | 3 |
| `brand_fonts` | many per company: family, weights / styles, usage, size guidance | 3 |
| `brand_terms` | many per company: term, approved / banned, note | 3 |
| `golden_rules` | many per company: rule, category, approved value, mandatory, active, created / updated | 3 |

| `company_logos` | one row per company (unique `company_id`): file_name, storage_path, mime_type, file_size, created / updated. The file itself is in Supabase Storage (D3) | 3 |

Every company-owned table has `company_id` → `companies(id)` with `on delete cascade`, so nothing can exist without its company and nothing is global.

## Company logos (D3 — Supabase Storage + PostgreSQL metadata)

```
Company
   ├── PostgreSQL  company_logos   (at most one row per company)
   │     id · company_id · file_name · storage_path · mime_type · file_size · created_at · updated_at
   └── Supabase Storage  private bucket "company-logos"
         {companyId}/{random id}.{png|jpg|webp|svg}      ← the only current logo file
```

- **Private bucket, server-only access.** The server talks to Storage's REST API with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (server-only env vars, never `NEXT_PUBLIC_`). The browser never gets a key.
- **No Storage policies on purpose.** `storage.objects` has row-level security on and QC adds no policies, so Supabase's anon / authenticated roles can read or write nothing in the bucket. Only the server (service role) can — after the app's own sign-in and D13 membership check. QC does not use Supabase Auth, so policies based on `auth.uid()` would not match QC users anyway.
- **Bucket created by migration** `0003_company_logos.sql` when the `storage` schema exists (Supabase): private, 2 MB limit, allowed types PNG / JPEG / WEBP / SVG. Elsewhere (tests) that step is skipped.
- **Paths are made by the server** from the authorised company ID and a random ID — never from the request. A database check (`storage_path` must start with `company_id/`) makes a mismatched path impossible to save.
- **Showing the logo:** the company page asks Storage for a **signed link valid for 1 hour**, made on the server after the access check. The link points at Supabase's domain, and the page shows it with an image tag, which never runs scripts — even inside an SVG.
- **Upload / replace:** upload the new file → save the metadata row (replacing the old row) → delete the old file. If saving the metadata fails, the new file is deleted again. If deleting the old file fails, the error is logged and the (private, unreferenced) file is left for manual clean-up.
- **Remove:** delete the metadata row → delete the file. Same logging if the file delete fails.
- **Checks on every upload (server):** size 1 byte – 2 MB; type worked out from the file's first bytes (PNG, JPEG, WEBP) or its text (SVG); the extension and the browser-declared type must agree with it. SVGs are **rejected** (not cleaned) if they contain scripts, event handlers, `javascript:` / non-image `data:` links, external references, embedded HTML (`foreignObject`), DOCTYPE definitions / entities, character references or style imports. (A plain public DOCTYPE, as Illustrator writes, is allowed.) This is a strict check, not a full SVG sanitiser — no sanitiser library is in the project.
- If a company is ever deleted (there is no delete feature yet), its metadata row goes with it; its file in Storage would need removing too.

## Company access (D13)

```
dashboard     ──▶  listCompaniesForUser: admin → all; designer → only companies in company_members
company page  ──▶  requireCompanyAccess(id): signed in? valid UUID? admin or member? — otherwise "not found"
every action  ──▶  requireCompanyAccess(id) again, then SQL that always includes "where company_id = $id"
                   (a Golden Rule of company A can't be changed through company B, even with a forged form)
```

- Creating a company adds its creator to `company_members` in the same statement.
- `npm run company:grant` adds another user to a company (there is no admin screen, per D2).
- `loadCompanyConfiguration()` in `lib/db/company-config.ts` returns a company's full saved configuration (information, contact, brand guidelines, Golden Rules). It is the one place the Phase 5 QC engine will read company data from.

Tables are prefixed `app_` so they are not confused with Supabase's own `auth.users`, which QC does not use.

## Authentication (D2)

```
npm run user:create  ──▶  asks name, email, role, password (hidden, twice)  ──▶  scrypt hash  ──▶  app_users
/login  ──▶  sign-in action (server)  ──▶  throttle check  ──▶  verify hash  ──▶  new app_sessions row
        ──▶  cookie: random token (httpOnly, Secure in production, SameSite=Lax, 12-hour expiry)
every page  ──▶  proxy.ts: no cookie → /login (quick check only)
            ──▶  requireUser(): cookie token hash → app_sessions + active app_users (the real check, on the server)
sign out  ──▶  deletes the app_sessions row and the cookie
```

- **No public registration.** Users exist only if someone with database access runs `npm run user:create`.
- **Roles:** `designer` and `admin`. Both reach the dashboard. `requireRole("admin")` is ready for later admin-only features; there is no admin screen yet.
- Code: `lib/auth/` (passwords, tokens, sign-in rules, current user), `lib/db/` (SQL), `scripts/` (command-line tools), `app/login/`, `proxy.ts`.

## The flow

```
Login → Dashboard → Company → Company info + Brand guidelines
      → Content type → Requirements + Upload → AI QC
      → Score board → QC result → Download report
```

## Pages (planned)

| URL | Page | Phase |
|---|---|---|
| `/login` | Sign in — the only page open to signed-out visitors | 2 (exists) |
| `/` | Signed-in home (Phase 2); becomes the dashboard to pick or add a company in Phase 3 | 2–3 |
| `/companies/new` | Add company | 3 |
| `/companies/[companyId]` | Company information + contact + logo (view / upload / replace / remove) + brand guidelines + Golden Rules (edit each item) + Start QC | 3 |
| `/companies/[companyId]/qc/new` | Start QC: content type → requirements → Upload Information → Upload Content → Save and continue (the designer's temporary session, D11). No QC runs yet | 4 |
| `/qc/[sessionId]` | Score board, result, findings, download report — only while the session exists | 7–8 |

No other pages: no QC history, upload history, file library, asset library or management screens.

## Folder structure

Only the folders marked **(exists)** are created so far. The rest are added in the phase that needs them.

```
skybook-qc/
├── docs/                    IMPLEMENTATION-PLAN.md, TRACKER.html, ARCHITECTURE.md (exists)
├── db/migrations/           numbered SQL files, applied by npm run db:migrate (exists)
├── scripts/                 command-line tools: db:migrate, user:create, qc:worker, qc:smoke:google (exists)
├── public/                  static files                      (exists)
├── test/mocks/              test stand-ins (server-only)      (exists)
└── src/
    ├── proxy.ts             quick "is there a sign-in cookie?" redirect      (exists)
    ├── app/                 pages and API routes — thin, they call lib/   (exists)
    │   ├── page.tsx         signed-in home (requireUser)                  (exists)
    │   ├── login/           sign-in page                      Phase 2 (exists)
    │   ├── companies/       new, [companyId], [companyId]/qc/new (placeholder) Phase 3 (exists)
    │   ├── qc/[sessionId]/                                    Phase 7–8
    │   └── api/                                               Phase 2+
    ├── components/
    │   ├── ui/              Button, Card, Badge … (generic)   (exists)
    │   ├── layout/          AppShell, Skybook mark (placeholder logo) (exists)
    │   ├── auth/            sign-in form, user menu           Phase 2 (exists)
    │   ├── company/         dashboard list, editable fields, list editors Phase 3 (exists)
    │   ├── qc/              content type, platform picker, requirements editor, file uploader, platform check, save / start over Phase 4–5 (exists)
    │   └── results/         score board, findings             Phase 7–8
    └── lib/                 business logic — no React here    (exists)
        ├── env.ts           reading settings safely           (exists)
        ├── security-headers.ts                                (exists)
        ├── auth/            sessions, passwords, roles        Phase 2 (exists)
        ├── db/              database access — users, company information, temporary QC sessions Phase 2–4 (exists)
        ├── company/         field rules, validation, access checks, server actions, logo checks Phase 3 (exists)
        ├── storage/         shared Supabase Storage client; logo bucket (D3) + temporary QC bucket (D11) Phase 3–4 (exists)
        ├── qc/              Phase 4 (exists): content-types, requirements, qc-file (upload checks),
        │   │                session (rules), access, actions, qc-input (the QC engine's input)
        │   ├── findings.ts  finding + rule types (5.1–5.2)     Phase 5 (exists)
        │   ├── platforms.ts approved platform values (D4)     Phase 5 (exists)
        │   ├── media-info.ts measures uploaded content        Phase 5 (exists)
        │   ├── compare.ts   comparison helpers (5.3)          Phase 5 (exists)
        │   ├── detections.ts what Phase 6 will detect (input shape) Phase 5 (exists)
        │   ├── rules/       one file per category + index (QC_RULES) Phase 5 (exists)
        │   ├── engine.ts    runs rules → findings             Phase 5 (exists)
        │   └── scoring.ts   scores + PASS / NEEDS REVISION / FAIL Phase 7
        ├── analysis/        provider interface, mock + Google, validation, media, worker, policy Phase 6 (exists)
        └── report/          builds the report from a session on download — not stored Phase 8
```

## Why it is split this way

- **Pages stay thin.** A page gathers data and shows it. Decisions (is this a FAIL?) live in `lib/`, where they can be tested without a browser.
- **Rules are data, not UI code.** A Golden Rule (saved per company) or a platform size (an app setting) is a definition the engine reads, so it can be changed without editing components.
- **AI is behind an interface.** The engine asks a provider for findings. Swapping the mock for a real provider changes one file, and a mock result is always labelled as one.
- **Saved and temporary data are kept apart.** Only `lib/db/` touches the database, so session code cannot save QC content by accident.
- **Severity decides the result; the score informs it.** `scoring.ts` applies "any critical issue → FAIL" before looking at the number.
