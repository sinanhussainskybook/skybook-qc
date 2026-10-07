# Skybook AI QC

Internal quality control for Skybook's design team. A designer uploads content before it goes to the client, and the app checks it against the company's information, brand guidelines, the brief and the QC rules. The result is **PASS**, **NEEDS REVISION** or **FAIL**, with a downloadable report.

> **Standalone application.** Skybook AI QC has no dependency on, and no integration with, Skybook Audit or any other Skybook project — no shared code, database, data or APIs. Requirements come only from the Skybook AI QC specification.

- Plan: [docs/IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md)
- Progress: [docs/TRACKER.html](docs/TRACKER.html) — open it in a browser, or at its [tracker link](https://claude.ai/artifact/PTpeAi5WUfZamiovD4JAvd) (private)
- How it is organised: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Content analysis (Phase 6 — provider, region, worker, FFmpeg, limits, cost): [docs/PHASE-6.md](docs/PHASE-6.md)
- Local AI provider (OCR, vision and speech on this server; no API calls): [docs/LOCAL-AI.md](docs/LOCAL-AI.md)

## Run it

Needs Node 22 or newer.

```bash
npm install
# put your settings in <home>/.skybook-qc/.env.local (see "Where secrets live" below)
npm run db:migrate           # create / update the database tables
npm run user:create          # create the first admin, then each designer
npm run dev                  # http://localhost:3200
npm run qc:worker            # second terminal: the content-analysis worker (Phase 6)
```

### Where secrets live

The project folder is synced by OneDrive, so **secrets are kept outside it**, in
`<home>/.skybook-qc/.env.local` (on this PC: `C:\Users\user\.skybook-qc\.env.local`), which is not synced.
Use the same `NAME=value` lines as `.env.example`.

- `next dev`, `next build`, `next start` (via `next.config.ts`) and every `npm run` script (via `scripts/lib/env.ts`) load that file with Node's built-in reader — `src/lib/external-env.ts`.
- A project `.env.local`, if one exists, is read first and wins. Don't keep secrets there while the project is in OneDrive.
- `.env*` files in the project are git-ignored. Nothing is printed, and no secret has a `NEXT_PUBLIC_` name, so none reaches the browser.

### Database and users

- The database is QC's **own Supabase PostgreSQL** project (D1). Put its connection string in `DATABASE_URL` in the secrets file above (see `.env.example`). Never commit it or paste it anywhere public.
- There is **no sign-up page** (D2). Accounts are created only with `npm run user:create`, run in an interactive terminal by someone with database access. It asks for the name, email, role (`admin` or `designer`) and password (hidden, typed twice, at least 12 characters). Only a hash of the password is saved.
- Without `DATABASE_URL` the app still builds and starts, but nobody can sign in.
- **Company access (D13):** whoever adds a company can open it; admins can open every company; to let another designer work on a company, run `npm run company:grant`.
- Optional `DATABASE_POOL_MAX` (1–20, default 5) limits how many database connections the app opens.
- **Company logos (D3)** are stored in a private Supabase Storage bucket, `company-logos`, which `npm run db:migrate` creates on Supabase. Set `SUPABASE_URL` (the bare project address, `https://<ref>.supabase.co` — no `/rest/v1`) and `SUPABASE_SERVICE_ROLE_KEY` (server only — never `NEXT_PUBLIC_`). Without them the app works, but files can't be uploaded or shown. This bucket is for logos only.
- **QC session files (D11)** — uploaded information and content — go to a separate private bucket, `qc-temp-files` (also created by `npm run db:migrate`), and are deleted automatically 24 hours after the session's last change. Never a design library or history.
- **Platform / Size QC (Phase 5, D4)** — the approved platform values are app settings in `src/lib/qc/platforms.ts` (each with its source link); change a value there. Migration `0005_qc_platform.sql` adds the platform choice to `qc_sessions` and the measured width / height / length / DPI to `qc_files` — run `npm run db:migrate` after updating.
- **QC rules (Phase 5)** — all nine categories are in `src/lib/qc/rules/` and run through one engine. Content analysis (Phase 6) fills them in; without it (or for anything not analysed) they show as *not verified*. Phase 5 is **frozen**; what Phase 6 must supply is the `ContentDetections` contract in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Component tests that need a browser DOM opt in with `// @vitest-environment jsdom` (dev dependencies `jsdom`, `@testing-library/react`).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the app for development on port 3200 |
| `npm run build` | Production build |
| `npm run typecheck` | TypeScript check |
| `npm run lint` | ESLint |
| `npm test` | Run the tests once |
| `npm run check` | typecheck + lint + tests, in one go (run before finishing any change) |
| `npm run db:migrate` | Apply new SQL files from `db/migrations/` to the database in `DATABASE_URL` |
| `npm run user:create` | Create a user account (interactive; no sign-up page exists) |
| `npm run company:grant` | Give a user access to a company (asks, or `npm run company:grant -- "Company name" email@x.com`) |
| `npm run qc:worker` | The content-analysis worker (Phase 6) — runs next to the app on the same host; needs `QC_ANALYSIS_PROVIDER` |
| `npm run qc:smoke:google -- --yes-call-google` | Opt-in, billable: one real Cloud Vision + one Gemini call on a synthetic image (never part of `npm test`) |
| `npm run qc:local:check` | Is this server ready for Local AI? Checksums of every model file, Ollama on loopback with the pinned model — downloads nothing |
| `npm run qc:smoke:local -- --yes-run-local` | Opt-in: the real local models on a synthetic design (minutes on CPU; never part of `npm test`) |
| `npm run qc:cleanup` | Delete expired QC sessions and their files now (the app also does this whenever Start QC is opened) |

## Stack

Next.js 16 (App Router) · React 19 · TypeScript (strict) · Tailwind CSS 4 · shadcn/ui on Base UI · lucide icons · Vitest · Supabase PostgreSQL via the `postgres` driver · Phase 6: zod, sharp, MuPDF (WASM), ffmpeg-static, google-auth-library, fflate · Local AI: ppu-paddle-ocr, onnxruntime-node (+ Ollama and whisper.cpp installed on the host)

Tests use PGlite (PostgreSQL in memory), so they run the real SQL without a network database.

UI components in `src/components/ui/` are generated from the official shadcn registry (`npx shadcn add <name>`). After adding one, check its `cn` import points at `@/lib/utils`.

> Next.js 16 differs from older tutorials. When unsure, check the docs shipped in `node_modules/next/dist/docs/`.

## Conventions

**Files and names**
- Files and folders: `kebab-case` (`app-shell.tsx`). Components: `PascalCase` (`AppShell`). Functions and variables: `camelCase`.
- Import from `src` with `@/` (`import { cn } from "@/lib/utils"`), not long `../../` paths.
- Tests sit next to the file they test: `env.ts` → `env.test.ts`. Shared test helpers go in `test/`.

**Where code goes**
- `src/app/` — pages and API routes. Keep them short; they call into `lib/`.
- `src/components/ui/` — generic building blocks (Button, Card). No business logic.
- `src/components/<feature>/` — components for one feature.
- `src/lib/` — business logic, QC rules, AI, files, reports. No React.
- One job per file. If a component passes ~200 lines, split it.

**Safety**
- Secrets only in `.env.local`, never in code, never with a `NEXT_PUBLIC_` prefix.
- Any file that reads secrets or the database starts with `import "server-only";`.
- Check every input on the server, even if the form already checked it.
- AI-extracted information is never used until a person confirms it.
- Never show a mock or uncertain AI result as if it were a verified fact.

**Styling**
- Use the theme colours (`bg-primary`, `text-muted-foreground`, `bg-pass-soft text-pass` …) rather than raw hex values.
- Result colours: `pass`, `revision`, `fail` (each with a `-soft` background).

**Independence**
- Never copy code, config, logic or data from another Skybook project. Start from the QC spec and standard Next.js / shadcn patterns.

**Finishing a change**
- `npm run check` passes, and `npm run build` for bigger changes.
- Update [docs/TRACKER.html](docs/TRACKER.html) and republish it to the tracker link. Only tick what is built and verified.
