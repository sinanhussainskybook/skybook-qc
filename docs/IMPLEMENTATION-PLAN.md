# Skybook AI QC — Implementation Plan

> Skybook AI QC is a standalone application. It has no dependency on, and no integration with, Skybook Audit or any other Skybook project. Everything in this plan comes from the Skybook AI QC specification.

**Status on 2026-09-29:** Phase 1 complete. D1 (Supabase PostgreSQL) and D2 (command-line user creation) approved. Phase 2 authentication is built and verified locally; Supabase production connection and first interactive user creation remain. Phase 3 (Company), including 3.5 Logos, is built and verified locally. D3 (logo storage: Supabase Storage + PostgreSQL metadata) approved. Verified on the real Supabase project on 2026-10-01: migrations 0001–0004 applied, encrypted database connection (TLS 1.3), both private buckets correct, logos and QC uploads working end to end, all temporary test data removed. Phases 1–4 complete. **2026-10-01: D4 approved; Phase 5 first round built and verified** (5.1, 5.2, 5.11, 5.13, the technical part of 5.14; migration 0005 applied to the real project). **2026-10-01 (round 2): Phase 5 complete** — every rule category (5.3–5.10, 5.12) built on the same engine and finding shape, tested with fixture detections, verified on the real project and in the production build; no migration needed. **2026-10-05: Phase 6 built and verified with the mock provider** — migration 0006 applied to the real project, the run queue, worker, local media preparation, confidence policy and information-file extraction verified on the real project and in the production build. **Not yet verified: real Google calls** (no credentials configured) — so Phase 6 is not complete. Details: [PHASE-6.md](PHASE-6.md). **2026-10-06: Local AI provider built** (`QC_ANALYSIS_PROVIDER=local`: PaddleOCR + Qwen3-VL 4B instruct on loopback Ollama + whisper.cpp; migration 0007) and verified on the real project and in the production build on this CPU-only PC (testing profile). **GPU acceptance on the target machine is still required** before designer use — [LOCAL-AI.md](LOCAL-AI.md). **2026-10-06: direction changed** — Local AI / GPU paused (this PC has no GPU); static designs only; Phase 7 (score) and Phase 8 / 8.1 (PDF report, Arabic, Asia/Dubai) built; **Gemini API provider built** (migration 0008). **2026-10-07: Gemini live** — key-format fix; Gemini 400 fixed (`minItems` / `maxItems` removed from the schema sent); clearer HTTP errors; boxes clamped when slightly out and discarded on their own when clearly invalid (position checks then not verified); **first live end-to-end run passed** (Version 1: NEEDS REVISION 94 / 100, PDF with logo, no history left). **Version 2 (wrong mandatory price) not yet confirmed live** — last try hit Gemini 503 overload. **Security:** Turbopack's on-disk cache had captured secrets inside the OneDrive folder — cache switched off, `.next` rebuilt, 0 secrets; key rotation waits on an OneDrive check.
Progress is tracked in [TRACKER.html](TRACKER.html) (also at its private [tracker link](https://claude.ai/artifact/PTpeAi5WUfZamiovD4JAvd)) — a short visual summary; the full task list is here. Task numbers (e.g. `4.3`) are the same in both files.

---

## 1. What we are building

A designer uploads content **before it goes to the client**. The app answers one question:

> Does this content contain everything the client asked for, and is it correct?

```
LOGIN → DASHBOARD → SELECT / CREATE COMPANY → COMPANY DETAILS
      → CHOOSE CONTENT TYPE → REQUIREMENTS + UPLOAD → AI QC PROCESSING
      → SCOREBOARD → QC RESULT → DOWNLOAD REPORT
```

One QC engine serves all four content types — **Design / Poster, Social Media Post, Reel / Short Video, YouTube Video**. Video adds extra checks inside the same engine; it is not a separate system.

> **AI provider for static designs (2026-10-06): the Gemini API (Google AI Studio, `GEMINI_API_KEY`)** — one call per design, no billing, no Vertex AI / Cloud Vision; Gemini's readings are AI evidence (never a counting CRITICAL). Free-tier data use and no EU region are open points — see [GEMINI.md](GEMINI.md). **2026-10-07:** smoke test passed (on `gemini-3.5-flash-lite`); the app now uses the default **`gemini-3.8-flash`** (no `QC_GEMINI_MODEL` set); one live end-to-end run passed. Gemini boxes are optional — see [GEMINI.md](GEMINI.md#bounding-boxes-positions-are-optional).
>
> **Scope for the first production version (2026-10-06): static designs only.** Start QC offers **Design / Poster** and **Social Media Post** (JPG, PNG, WEBP, PDF). Reel / Short and YouTube Video are **hidden, not removed** — their rules, video analysis and platform specs stay in the code for later (`OFFERED_CONTENT_TYPES` in `lib/qc/content-types.ts`). The server refuses a hidden type for a new or changed session. Local AI / GPU work is paused.

### Out of scope (never built unless you ask)

Website auditing, SEO, PageSpeed, crawling, uptime or server monitoring · New Hive integration · CRM, project, task, employee or billing management · publishing or scheduling · design library, asset library, recent uploads, general file storage · a "Fix Again" button · saved QC history, previous QC results, stored reports or stored designs.

---

## 2. Working rules

1. One phase at a time, and only after you approve it.
2. Before each phase: inspect the project and explain the changes in plain language.
3. After each phase: tests, typecheck, lint, production build, check in the browser, update the tracker, report honestly.
4. Nothing is ticked until it is built **and** verified.
5. If a feature's place in QC is unclear, stop and ask.
6. Business logic lives in `src/lib/` and is tested without a browser. Pages stay thin.
7. The AI is never the final authority: extracted information needs a person's confirmation, and uncertain findings are labelled as judgements, not facts.
8. **Only company and application information is saved.** Everything about the content being checked lives in a temporary QC session and is deleted when the session ends (see section 4).

---

## 3. Decisions still open

Each one blocks the phase shown. I will ask about each before that phase starts, with a recommendation.

| # | Decision | Needed before |
|---|---|---|
| D1 | ✅ **Decided 2026-09-29 — Supabase PostgreSQL.** QC's own project, never shared with another. Stores only users (with their sign-in records) and company information (see section 4). Connected through an environment variable (`DATABASE_URL`, server only); no credentials in code or chat. The app does its own sign-in against this database — Supabase Auth is not used | — |
| D2 | ✅ **Decided 2026-09-29 — command-line user creation** (`npm run user:create`). No public sign-up and no admin user-management screen. Two roles: `admin` and `designer` | — |
| D3 | ✅ **Decided 2026-09-29 — Supabase Storage + PostgreSQL metadata.** The logo file lives in a private Supabase Storage bucket (`company-logos`); its metadata (file name, storage path, type, size) lives in the `company_logos` table, one current logo per company. Never stored as a database blob. No logo history and no old versions. This storage is for company logos only — never designs, content, requirement files, temporary QC files or reports | — |
| D4 | ✅ **Decided 2026-10-01 — values researched from each platform's own published page and approved by you as listed.** Kept in code (`src/lib/qc/platforms.ts`), each placement with its source link: **Instagram** (Meta Ads Guide — Feed image 4:5, allowed 4:5–1.91:1 ±1 %, min 500 px wide, 30 MB; Stories image 9:16 ±1 %; Feed / Stories video; Reels 9:16, min 500 px wide from 30 s, up to 15 min, 4 GB), **Facebook** (Feed image 4:5 ±3 %, min 600 × 750; Stories; Feed / Stories video; Reels *not configured* — no page available), **LinkedIn** (LinkedIn Help — landscape 1.91:1 / square / vertical images with min–max sizes, 5 MB; video 16:9, 1:1, 4:5, 9:16, 75 KB–500 MB, 3 s–30 min, MP4), **YouTube** (YouTube Help — 16:9 standard, resolution guide 426 × 240 to 7680 × 4320; Shorts square or vertical, up to 3 min), **Display ad** (Google Ads uploaded image ads — 20 exact sizes, 150 KB, JPG / PNG). **Website banner, Email banner, Print, Presentation slide, Other** have no official spec: the designer types the required size (px, or mm + optional DPI for print; Other also needs a description). File sizes use decimal units (1 MB = 1,000,000 bytes). Where a platform publishes no tolerance, a different ratio is only a SUGGESTION; ratio matching for lists / typed sizes uses 1 % and print page size ±1 mm (app settings, not platform values). Severities: MAJOR for a broken published limit; SUGGESTION for below-recommended resolution, recommended-only ratios and YouTube's resolution guide; safe zones and anything not measurable are UNVERIFIED; nothing is CRITICAL. Ad-copy text limits aren't checked (they apply to ad text fields, not the creative) | — |
| D5 | ✅ **Decided 2026-10-04 — Google Cloud, EU only:** Cloud Vision `DOCUMENT_TEXT_DETECTION` + Gemini 3.8 Flash (Vertex AI) behind a provider-neutral interface; Gemini 3.5 Flash-Lite a possible cost fallback; Claude only as an interface-level backup (not built). Zero-data-retention / abuse-monitoring exception **REQUESTED / PENDING** — no zero-retention claim until Google confirms. See [PHASE-6.md](PHASE-6.md) | — |
| D6 | ✅ **Decided 2026-10-04 — FFmpeg on our server.** The original video never leaves the server; at most 15 minutes analysed, at most 120 OCR frames (Vision), Gemini for speech and up to 8 key frames, loudness / true peak measured by FFmpeg. Upload limit stays 50 MB. Not analysed → NOT VERIFIED | — |
| D7 | **Score weights and result thresholds** (a proposal is in Phase 7). Inputs to settle with it: only *failed* findings count; how to present a session where most checks are not verified; the severity notes under "Phase 5 freeze" in ARCHITECTURE.md | Phase 7 |
| D8 | ✅ **Decided 2026-10-06 — PDF**, built in memory on download with pdf-lib (MIT) and never stored. Text uses embedded **Noto Sans + Noto Sans Arabic** (SIL Open Font License) so Arabic is readable; if the fonts can't load, the built-in Helvetica is used. **Report time zone: Asia/Dubai** (setting `QC_REPORT_TIME_ZONE`) | — |
| D9 | **Human review** (accept / reject / intentional / comment) — deferred after Phase 8 | Later |
| D10 | ✅ **Decided 2026-10-04 (processing part) — a persistent Node.js host** running the app and a worker (`npm run qc:worker`) from the same code; PostgreSQL queue with row locking (no Redis / BullMQ / Kafka); 2 runs at a time, 3 provider calls per run; heartbeat + stale recovery. Choosing the actual host remains for Phase 9 (9.9) | Phase 9 |
| D11 | ✅ **Decided 2026-09-29 — temporary database rows + a temporary private bucket.** A QC session, its requirements and its file records are rows in Supabase PostgreSQL (`qc_sessions`, `qc_requirements`, `qc_files`); the files themselves are in a private Supabase Storage bucket `qc-temp-files`, separate from logos. Everything is **deleted automatically 24 hours after the session's last change**. One current session per designer per company; starting over deletes the old one. No history. Size limits: 25 MB per file (`MAX_UPLOAD_MB`), **50 MB for video** (Supabase Free plan's maximum) | — |
| D13 | ✅ **Decided 2026-09-29 — company access is by membership.** Whoever creates a company becomes a member automatically. Admins see and edit every company. A designer sees only companies they are a member of; others are added with `npm run company:grant` (no admin screen, per D2). Any other company ID in a URL or form gives "not found" | — |
| D12 | ✅ **Decided — Golden Rules are saved** as part of each company's persistent brand / QC configuration, are editable with the company's saved information, and apply automatically whenever that company is selected for a QC session | — |

---

## 4. What is saved and what is temporary

### Saved in the database

Only information that must still be there for future QC sessions:

| Thing | Holds | Phase |
|---|---|---|
| **User** | name, email, password hash, role (designer / admin), active | 2 |
| **Sign-in records** | part of the user account: active sign-in sessions (a hash of the cookie token + expiry, removed on sign-out) and failed sign-in counters (cleared on success). No QC content | 2 |
| **Company** | name, description, type / category, country, city, address, active, created by | 3 |
| **Company members** | which users may open which company (D13) | 3 |
| **Contact** | phone, WhatsApp, email, website — one set per company | 3 |
| **Logo** | one current logo per company: the file in private Supabase Storage; file name, storage path, type, size and dates in `company_logos` (D3). Replacing it deletes the old file | 3 |
| **Brand guidelines** | colours (name + HEX, optional CMYK; RGB is shown worked out from the HEX, not stored), fonts (family, weights / styles, usage, size guidance), approved / banned terms, tone, capitalisation rules, naming conventions, logo rules (min size, clear space, placement — as text), template notes, other guidelines | 3 |
| **Golden Rules** | part of the company's brand / QC configuration: rule, what it covers (mandatory disclaimer, approved product name, approved CTA, logo rule, approved colours, approved fonts, other), the approved value where there is one, mandatory yes/no, active yes/no. Editable; applied automatically to every QC session for that company (D12) | 3 (edit), 5 (applied) |

Platform size values (D4) and the QC rule definitions are application settings, kept in the code as configuration files rather than as user data.

### Temporary QC session (deleted automatically — D11)

Everything about the content being checked belongs to one QC session. It is held **temporarily** — session, requirements and file records as database rows, the files in the private `qc-temp-files` bucket — and **deleted automatically 24 hours after the session's last change**, or when the designer starts over (D11):

| Thing | Holds | Phase |
|---|---|---|
| **QC session** | signed-in designer, company, content type, platform + placement (or a typed size), status | 4–5 |
| **Requirements** | type (headline, price, CTA, …), expected value, notes, source (typed / extracted), confirmed yes/no | 4 |
| **Uploaded information** | the file and the items extracted from it, waiting for review | 4 |
| **Content** | the design or video being checked, with format and size (Phase 4) and width, height, duration, DPI, pages measured from the file itself (Phase 5) | 4–5 |
| **Findings** | category, rule, severity, status (passed / failed / unverified / not applicable), kind (fact / judgement), expected, detected, confidence, explanation, suggested fix, location | 5–6 |
| **Result** | overall score, category scores, counts, PASS / NEEDS REVISION / FAIL | 7 |
| **Report** | built from the session when the designer clicks Download — not stored | 8 |

So there is no QC history: once a session ends, its content, requirements, results and report are gone. The designer keeps the downloaded report.

Every QC session reads the company's saved information — including its Golden Rules — automatically. A session never changes it.

---

## 5. Phases

### Phase 1 — Project foundation ✅ Complete

Next.js 16, React 19, TypeScript (strict), Tailwind CSS 4, shadcn on Base UI, Vitest. App shell, Skybook theme with PASS / NEEDS REVISION / FAIL colours, security headers, validated settings, docs. Cleaned so nothing comes from another project.

---

### Phase 2 — Authentication

**Goal:** only signed-in Skybook staff can use the app.
**The designer sees:** a sign-in page (email + password), then the app. A sign-out option in the header.
**Decided:** D1 Supabase PostgreSQL, D2 command-line user creation.

| # | Task |
|---|---|
| 2.1 | Connect QC's own Supabase PostgreSQL database (`DATABASE_URL`) and set up SQL migrations (`npm run db:migrate`) — for saved information only |
| 2.2 | User record: name, email, password hash, role, active |
| 2.3 | Password hashing (never store the password itself) |
| 2.4 | Create users with `npm run user:create` — asks for name, email, role and password (hidden, typed twice), hashes it, saves the user |
| 2.5 | Sign-in page with clear errors ("email or password is incorrect" — never which one) |
| 2.6 | Session: random, unguessable token in an httpOnly, secure, SameSite cookie that expires; the database keeps only a hash of it, so sign-out ends it everywhere |
| 2.7 | Every page and API route requires sign-in; checked on the server |
| 2.8 | Sign out |
| 2.9 | Roles stored (designer, admin) — used later only where needed |
| 2.10 | Limit repeated failed sign-in attempts |
| 2.11 | Tests: hashing, session, protected routes, rate limit, sign-in form |
| 2.12 | Verification |

**Not included:** public sign-up, password-reset emails, admin user-management screens (D2 chose the command line). The `admin` role is stored and checked on the server, ready for later administrative features.
**Done when:** a signed-out visitor is sent to sign-in from every URL; correct details get in; wrong details don't; sign-out ends the session.

---

### Phase 3 — Company

**Goal:** the app knows which company and brand is being checked. Everything in this phase is **saved in the database**, ready for every future QC session.
**The designer sees:** a dashboard listing companies → pick one or add one → a company page with sections, each with its own **Edit** button.
**Decided:** D3 (logo storage), D13 (access).

| # | Task |
|---|---|
| 3.1 | Company record and dashboard list (only the companies the user may access) |
| 3.2 | Add company (name required; everything else optional); creator becomes a member; `npm run company:grant` adds others |
| 3.3 | Company page: information section — name, description, type / category, country, city, address — each field with Edit |
| 3.4 | Contact section — phone, WhatsApp, email, website — each with Edit and format checks. Phone and WhatsApp are saved exactly as typed (only trimmed), never rewritten; comparing numbers is a Phase 5 helper (5.3). Websites are saved as a full `https://` address; no request is made to the site |
| 3.5 | Logo — view, upload, replace, remove one current logo (PNG, JPG, WEBP, SVG up to 2 MB; type checked from the file's contents, name and declared type on the server; risky SVGs rejected). File in private Supabase Storage, metadata in `company_logos` (D3). Shown through a short-lived signed link made on the server |
| 3.6 | Brand guidelines — colours, fonts, tone, terminology, capitalisation, logo rules, template notes — each with Edit |
| 3.7 | Golden Rules — add, edit, switch off, remove, as part of the brand guidelines. Examples: mandatory disclaimer, approved product name, approved CTA, logo rules, approved colours, approved fonts, other company-specific non-negotiable rules. Each marked mandatory or not |
| 3.8 | "Start QC" entry point on the company page. Leads to `/companies/[id]/qc/new`, which in Phase 3 only says the QC workflow arrives in Phase 4 — no fake QC |
| 3.9 | Tests: validation, saving, editing, access between companies, Golden Rules, logo upload checks and storage behaviour (Storage replaced by a test double) |
| 3.10 | Verification |

**Done when:** a designer can add a company, fill in and edit every section including its Golden Rules, and the data is saved — and cannot open a company they are not a member of — including uploading, replacing, viewing or removing its logo.

---

### Phase 4 — Requirements + Upload

**Goal:** everything needed for a QC check is gathered on one simple page, inside a **temporary QC session** (D11). No AI, no OCR, no scoring, no report.
**Decided:** D11 (temporary rows + temporary bucket, 24 h after last change; video 50 MB, other files 25 MB).
**The designer sees:** Start QC → choose a content type → one page with Requirements, Upload Information and Upload Content → **Save and continue** (session marked Ready for the QC engine of Phases 5–6).

| # | Task |
|---|---|
| 4.1 | Choose content type — Design / Poster, Social Media Post, Reel / Short, YouTube Video — one shared session model with a `content_type` field; starts (or resumes) the designer's one current session for the company |
| 4.2 | Requirements: **+ Add Requirement**, edit, delete, mandatory, confirmed. Types come from a code list (headline, required text, offer, price, percentage, date, time, phone, WhatsApp, email, website, CTA, product, service, location, disclaimer, campaign, platform, dimensions, target audience, special instruction, other) — the database accepts new type keys without a migration |
| 4.3 | Platform and size selection — **moved to Phase 5 (5.11) with D4** — ✅ built there (2026-10-01). "Platform" and "Dimensions" also remain requirement types |
| 4.4 | **Upload Information** (PDF, DOC, DOCX, XLS, XLSX, TXT, JPG, JPEG, PNG, WEBP) — checked by the file's contents, name and declared type; 25 MB |
| 4.5 | Read the text out of those files — **moved to Phase 6 (6.7)**, the extraction work, per the Phase 4 brief |
| 4.6 | Find likely requirements in that text — **moved to Phase 6 (6.7)** with 4.5 |
| 4.7 | Review extracted information — the data model and "Needs review" state are built now (`source = extracted`, unconfirmed, never used until confirmed); the review screen for extracted items is **moved to Phase 6 (6.7)** |
| 4.8 | **Upload Content** — types follow the content type: images + PDF for Design / Poster and Social Media Post, MP4 / MOV / WEBM for Reel and YouTube; checked on the server; 25 MB (video 50 MB) |
| 4.9 | **Save and continue** — marks the session Ready once content is uploaded and every requirement is confirmed; warns when company information is missing. No QC runs yet |
| 4.10 | Temporary session handling (D11): only the designer who started it can open it; rows and files deleted automatically 24 h after the last change, or on Start over |
| 4.11 | Tests: sessions, requirements, upload checks, access between companies / designers, expiry clean-up |
| 4.12 | Verification (incl. real Supabase Storage) |

**Done when:** a designer can go from company to a Ready session with confirmed requirements and uploaded content, only they can open it, and nothing from it is left behind after it expires.

---

### Phase 5 — QC rule engine ✅ Complete — FROZEN 2026-10-01

**Goal:** the QC logic exists as tested, configurable rules — separate from the screens and from the AI.

**Status (2026-10-01): ✅ Complete.** Round 1: Platform / Size (5.1, 5.2, 5.11, 5.13, video size / ratio / length). Round 2: comparison helpers and the Content, Brand, Golden Rules, Design & Layout, Accessibility, Image & Asset, Brief and Legal rules, plus the rest of the video checks — all in `src/lib/qc/rules/`, run by the one engine. As this phase defines, the rules read **detections** (`src/lib/qc/detections.ts`) that tests supply as fixtures; in the app they are `null` until Phase 6 reads the content, so those checks show **not verified** (5.13). Platform / Size already works on real uploads (measured files). Severities are each rule's `defaultSeverity` (table in ARCHITECTURE.md) — a mandatory requirement or Golden Rule broken is CRITICAL; Rule of Thirds is only ever a SUGGESTION. Also fixed: a refused requirement save no longer wipes what was typed.

**Frozen 2026-10-01 after a final review.** Phase 5 defines the rules; Phase 6 supplies the detections (the contract is the `ContentDetections` table in ARCHITECTURE.md). Live non-platform checks show **not verified**, which never counts for or against the result. The severity model is CRITICAL / MAJOR / MINOR / SUGGESTION. The result model is PASS / NEEDS REVISION / FAIL (Phase 7, D7), and only *failed* findings count. Subjective recommendations (Rule of Thirds, headline hierarchy) are SUGGESTION judgements and never block a PASS. Review changes:
- headline hierarchy MINOR → SUGGESTION;
- Rule of Thirds and colour-only meaning always worded as judgements;
- two contact-detail false positives fixed (year ranges, "Word.Word");
- per-file frame sizes.

No Phase 6 code was added. Changes to Phase 5 after this point go through a new decision.

How it works: the engine takes **approved information** (company, brand, requirements, Golden Rules, platform) and **what was detected in the content** (text, colours, fonts, logo, sizes) and produces **findings**. In this phase the detections come from test fixtures; Phase 6 supplies real ones.

| # | Task |
|---|---|
| 5.1 | ✅ Shared types: 9 categories, 4 severities, finding status (passed / failed / unverified / not applicable), finding kind (fact / judgement) — `lib/qc/findings.ts`, the one finding shape every rule uses |
| 5.2 | ✅ Rule definition format: id, category, which content types it applies to, what information it needs, default severity, mandatory yes/no — plus a small engine (`lib/qc/engine.ts`) that runs the rules for a content type |
| 5.3 | ✅ Comparison helpers (`lib/qc/compare.ts`): text, phone (country code aware), price (currency + amount), percentage, date (ambiguous numeric dates keep both readings), time, email, website, CTA, required text present, close misspellings of names — plus colour contrast / difference and font-family matching used by the rules |
| 5.4 | ✅ Content QC rules (`rules/content.ts`): contact details shown match the company's saved ones or the brief (wrong → CRITICAL; local number without country code → MINOR), company name misspelt (MAJOR), placeholder text left in (CRITICAL), repeated words (MINOR) |
| 5.5 | ✅ Brand QC rules (`rules/brand.ts`): brand colours used and text colours on-palette (MINOR), brand fonts only (MAJOR), banned / misspelt approved terms (MAJOR), logo present (MAJOR) and the right one (wrong logo → CRITICAL); written guidelines (tone, capitalisation…) listed as not verified for a person |
| 5.6 | ✅ Golden Rules (`rules/golden-rules.ts`) — every ACTIVE saved rule applied automatically: disclaimer word for word, product name, CTA, colour, font; worded rules (logo rule, other) listed as not verified. Mandatory broken → CRITICAL, optional → MAJOR |
| 5.7 | ✅ Design & Layout QC rules (`rules/layout.ts`): overlapping text (MAJOR), text too close to the edge (MINOR), headline is the largest text (MINOR), Rule of Thirds — always a SUGGESTION, never a failure; video: on-screen text long enough to read (MINOR) |
| 5.8 | ✅ Accessibility QC rules (`rules/accessibility.ts`): WCAG contrast 4.5 : 1 / 3 : 1 for large text (MAJOR), text size ≥ 1.5 % of the shorter side (MINOR), colour-only meaning (MINOR); video: captions for speech (MINOR) |
| 5.9 | ✅ Image & Asset QC rules (`rules/image-asset.ts`): stock watermark (CRITICAL), blurry / pixelated / stretched (MAJOR), cut off (MINOR); video sound: none (SUGGESTION), clipping (MINOR), loudness (SUGGESTION) |
| 5.10 | ✅ Brief QC rules (`rules/brief.ts`) — every confirmed requirement: missing (mandatory CRITICAL / optional MINOR), wrong (CRITICAL / MAJOR), mismatched — misspelt, currency or country code left out (MAJOR); unexpected prices, percentages and dates not in the brief (MAJOR if the brief has one of that kind, else MINOR). Video counts what is said too |
| 5.11 | ✅ Platform / Size QC rules with configurable platform specs (values per D4). The designer picks **platform, then placement** (or types the size for banner / print / slide / other) on the Start QC page; the content's real width, height, length and DPI are **measured from the uploaded file** (PNG, JPG incl. EXIF rotation, WEBP, PDF page size, MP4 / MOV incl. rotation, WEBM) and stored on `qc_files`; findings (format, ratio, min / max / exact size, recommended resolution, file size, length, print DPI, safe zone) are shown in a **Platform check** section as Expected / Detected / Issue / Suggested fix. Ready now needs a platform. No score and no PASS / FAIL (Phase 7) |
| 5.12 | ✅ Legal & Compliance QC (`rules/legal.ts`) — only configured rules: disclaimers in the confirmed brief must be on screen word for word (mandatory → CRITICAL). With none configured the category says "not applicable"; nothing is invented |
| 5.13 | ✅ UNVERIFIED when approved information or a detection is missing — never a guess (unmeasurable files, PDF pixel size / DPI, safe zones, unconfigured placements) |
| 5.14 | ✅ Video-only checks registered in the same engine — duration, aspect ratio, resolution (5.11, on measured files); on-screen text (timed text in Brief / Content / Legal, time to read), spoken text (transcript counts for the brief and contact details; captions) and audio (sound present, clipping, loudness) — fixture-tested, filled by Phase 6 (6.6) |
| 5.15 | ✅ Tests for every rule, including the "missing information → UNVERIFIED" case and boundaries; one test runs every category through the engine for all four content types |
| 5.16 | ✅ Verification — both rounds on the real Supabase project (real saved brand, Golden Rules, confirmed requirements and a measured upload through every rule; temporary data removed, real data unchanged) and in the production build |

**Done when:** given fixture inputs, the engine returns the right findings for every category, and rules can be changed without touching screens.

---

### Phase 6 — AI analysis

**Goal:** real content is analysed and fed into the engine.
**The designer sees:** a processing screen with progress, then results. Failures are explained, not hidden.
**Decided:** D5, D6, D10 (processing), confidence policy — 2026-10-04. Data retention at Google: exception REQUESTED / PENDING (see [PHASE-6.md](PHASE-6.md)). **Status 2026-10-05:** built; verified with the mock provider on the real project and in the production build; real-provider smoke test not yet run (no credentials). **Status 2026-10-07:** the provider for static designs is the **Gemini API** (6.13–6.15 below); Local AI and the Google (Vertex + Vision) provider stay in the code, paused. Phase 6 is complete once Version 2 passes live (6.15).

| # | Task |
|---|---|
| 6.1 | ✅ Provider interface (`lib/analysis/provider.ts`): read text, judge image, transcribe, extract requirements — raw answers, validated outside the provider |
| 6.2 | ✅ Mock provider — every result marked **"Sample data — not real AI"**; failure / retry / malformed / slow scenarios by file name |
| 6.3 | ✅ Real provider: **Local AI** (`QC_ANALYSIS_PROVIDER=local` — PaddleOCR + Qwen3-VL 4B instruct on loopback Ollama + whisper.cpp; pinned models, no API calls) verified end to end with the real models on this PC. The Google provider stays optional / future (built, live call not verified) |
| 6.4 | ✅ OCR → text, boxes, size, confidence, page numbers, measured colours — local PaddleOCR with an independent second read (verified on real models); Vision format still supported |
| 6.5 | ✅ Visual analysis: measured colours; AI roles, logo (vs the saved logo), focal point, image issues, colour-only meaning — local Qwen3-VL verified on real models (fonts rarely named → not verified) |
| 6.6 | ◐ Video (D6): local FFmpeg frames, duplicate removal, timed text, whisper.cpp transcript, loudness — each part verified with real local models; a full video run through the Local AI page flow still to do |
| 6.7 | ✅ Information files: TXT / DOCX / XLSX / PDF text read locally, scanned pages and images by OCR; pattern rules + AI proposals that must quote the file; all stored unconfirmed and optional for review ("Find requirements in these files"); old .doc / .xls reported as unsupported |
| 6.8 | ✅ Strict validation (zod): size, JSON, depth, unknown fields, ids, confidence, coordinates, timestamps, item counts |
| 6.9 | ✅ Confidence policy (measured 0.80 / critical 0.90 / coverage 0.90; AI never a counting CRITICAL → "Needs a human check — possible critical issue"; partial analysis → NOT VERIFIED) |
| 6.10 | ✅ Run queue (migration 0006), worker, heartbeat / stale recovery, progress polling, Try again, 5 runs per session |
| 6.11 | ✅ Tests with recorded responses and the mock; no live calls; opt-in smoke test `npm run qc:smoke:google -- --yes-call-google` |
| 6.12 | ⏸ Real Supabase ✅ (migration 0007) and production-build browser check ✅ with a real Local AI run on this CPU; GPU acceptance — **paused** (no GPU; Local AI is future work) |
| 6.13 | ✅ **Gemini API provider** (`QC_ANALYSIS_PROVIDER=gemini`, `GEMINI_API_KEY`, migration 0008): one call per design with the confirmed requirements and company rules as data; Gemini evidence never a counting CRITICAL; key sent in a header only; recorded-answer tests; opt-in smoke test `npm run qc:smoke:gemini -- --yes-call-gemini` — **passed 2026-10-07** |
| 6.14 | ✅ Gemini hardening (2026-10-07): dotted AI Studio keys accepted; `minItems` / `maxItems` removed from the schema sent (Gemini answered 400); HTTP status + Google's short message on every error (key never shown); box coordinates slightly outside 0–1000 clamped, clearly invalid boxes discarded on their own (never sign-flipped) — position / size checks then **not verified**, never passed; everything else still validated strictly |
| 6.15 | ◐ Live end-to-end on real Supabase with TEMP data: **Version 1 ✅** (correct price, wrong date, banned word, logo → NEEDS REVISION 94 / 100; PDF with logo; Start over leaves nothing). **Version 2 — wrong mandatory price → "Needs a human check", not FAIL — not yet confirmed live**: failed twice on invalid boxes (now handled; proven with the recorded answer) and once on Gemini 503 overload |

**Done when:** an uploaded image and a video each produce findings with expected vs detected and confidence, and the mock is never mistaken for real AI.

---

### Phase 7 — Score & result ✅ Built 2026-10-06 (weights: the proposal below, D7 to confirm)

**Goal:** a clear, fair decision.
**The designer sees:** the scoreboard — overall score, category scores, issue counts — and a large PASS / NEEDS REVISION / FAIL banner.

**Proposed logic (to confirm in D7):**
- Each category starts at 100 and loses points per failed finding: Critical −40, Major −15, Minor −5, Suggestion 0.
- UNVERIFIED and not-applicable checks don't count either way, and are listed separately.
- Overall score = average of the categories that had checks.
- **Result — severity decides first, the score second:**
  1. Any Critical finding (including a mandatory Golden Rule) → **FAIL**, whatever the score.
  2. Otherwise, any Major or Minor finding → **NEEDS REVISION**.
  3. Otherwise → **PASS**. Suggestions never block a PASS.

| # | Task |
|---|---|
| 7.1 | ✅ Category scores (`lib/qc/scoring.ts`): 100 minus 40 / 15 / 5 / 0 per counting critical / major / minor / suggestion, never below 0; categories with no answered check are "Not checked" |
| 7.2 | ✅ Overall score: average of the categories with an answered check, rounded |
| 7.3 | ✅ Counts: Critical, Major, Minor, Suggestion, plus "Needs a human check" and Not verified (never counted) |
| 7.4 | ✅ Result: any counting CRITICAL → FAIL; otherwise any MAJOR / MINOR → NEEDS REVISION; otherwise PASS. Suggestions, not verified and human checks never count; no answered check → no result yet |
| 7.5 | ✅ Scoreboard in a "QC result" section on Start QC (shown once the content is analysed): score, issue counts, score by category, "What to fix" with severity and category |
| 7.6 | ✅ Result banner — colour, icon and wording; sample-data results say "This is not a real QC result" |
| 7.7 | ✅ Tests for every boundary, incl. "scores 96 but has a missing mandatory price → FAIL" and "only suggestions → PASS" |
| 7.8 | ✅ Verified: full suite, typecheck, lint, build; production-build browser check on real Supabase (mock provider): FAIL at 94 / 100 for a missing mandatory price; phone width OK; temporary data removed |

---

### Phase 8 — QC report ✅ Complete 2026-10-06 (agreed scope: the PDF report; 8.3 and 8.6 deferred)

**Goal:** the designer understands every issue and can download a professional report.
**Decided:** D8 (PDF, built in memory on download). D9 (human review) deferred. The report is built from the current session when downloaded and is not stored; the page says so next to the download button.

| # | Task |
|---|---|
| 8.1 | ✅ Results on the Start QC page: the QC result (Phase 7) and "Content checks" by category, passed checks included |
| 8.2 | ✅ Each finding: severity, expected vs detected, explanation, suggested fix; uncertain items labelled "Needs a human check" (confidence is applied by the policy, not shown as a number) |
| 8.3 | ⏸ Deferred — boxes on the image where the issue is (timestamps for video). Not in the agreed Phase 8 scope |
| 8.4 | ✅ **Download QC report (PDF)** — `/companies/[id]/qc/report`: company name and logo, QC date, content type, platform, files, result, score, severity counts, category scores, requirements checked, issues (severity, category, issue, expected, detected, fix), "Needs a human check" and not verified items. Built in memory with pdf-lib; never stored. Only the session's owner can download it |
| 8.5 | ✅ Run QC again in the same session (upload the fixed content → Analyse again); the earlier result is replaced, not kept |
| 8.6 | ⏸ Deferred — human review (accept / reject / intentional / comment), D9 |
| 8.7 | ✅ Tests: PASS / NEEDS REVISION / FAIL reports, critical, human-check and not-verified findings, missing / damaged logo, empty findings, Arabic text (embedded fonts, joined letters, read back by MuPDF), fallback font, route access |
| 8.8 | ✅ Verified: full suite, typecheck, lint, build; a real PDF downloaded from the production build on real Supabase with the company logo; Arabic report checked visually |

---

### Phase 9 — Testing & polish

**Goal:** stable, understandable, ready for the team.

| # | Task |
|---|---|
| 9.1 | Review unit and rule tests for gaps |
| 9.2 | Upload tests (wrong types, too large, renamed files, empty files) |
| 9.3 | ◐ End-to-end test for each offered content type (Design / Poster, Social Media Post); video types when they are offered again — Design / Poster Version 1 passed live 2026-10-07; Version 2 and Social Media Post to do |
| 9.4 | Error, empty and loading states on every screen |
| 9.5 | Mobile / responsive check |
| 9.6 | Accessibility check (keyboard, labels, contrast) |
| 9.7 | ◐ Security review (sign-in, uploads, secrets, access between companies, temporary session files really deleted) — 2026-10-07: secrets found in Turbopack's on-disk cache inside the OneDrive folder (never served to browsers); fixed by `turbopackFileSystemCacheForBuild / ForDev: false` in `next.config.ts`, `.next` rebuilt, 0 secrets. **Pending: check OneDrive (and its recycle bin) for `skybook-qc/.next`; if it was ever synced, rotate `SUPABASE_SERVICE_ROLE_KEY` (copies since 29 Sep) and preferably `GEMINI_API_KEY`** |
| 9.8 | Performance (large files, long videos) |
| 9.9 | Deployment set-up (per D10) and production build |
| 9.10 | Final verification |

**Known issues found in the live tests (2026-10-07), not yet fixed:**
- The Start QC page twice jumped to the home page by itself while a Gemini analysis was running — to investigate.
- A wrong date counts twice ("Date" and "Unexpected offer details" — two MAJORs for one mistake); a Phase 5 rule question, needs a decision.
- A failed analysis shows a technical reason to the designer (e.g. "invalid analysis response…"); a plain message would be clearer.
- Gemini free tier: Google may use what is sent — use non-confidential designs, or a paid tier, before real client work.

---

## 6. How each phase is checked

| Check | Command |
|---|---|
| Types | `npm run typecheck` |
| Lint | `npm run lint` |
| Tests | `npm test` |
| Build | `npm run build` |
| In the browser | start the app and click through the new screens, desktop and phone width |

## 7. Main risks

| Risk | How we handle it |
|---|---|
| AI reads text or numbers wrongly | Confidence on every finding; expected vs detected shown side by side; low confidence flagged for a human |
| AI extraction invents requirements | Nothing extracted is used until a designer confirms it |
| Subjective design advice presented as fact | Findings carry a kind (fact / judgement); judgements are worded as recommendations |
| Missing company information causes false failures | Missing information gives UNVERIFIED, not FAIL |
| Video processing is slow or heavy | Decided up front (D6); time limits; progress shown |
| Scope creep into libraries or management | Out-of-scope list above; ask before adding anything not in the spec |
| Designer loses results when the session ends | Clear reminder to download the report; session lifetime set in D11 |
| Temporary files left behind | Deleted on session end and on expiry; covered by tests (4.11) and the security review (9.7) |
