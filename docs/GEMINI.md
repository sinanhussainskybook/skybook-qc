# Gemini API provider (Google AI Studio)

`QC_ANALYSIS_PROVIDER=gemini` analyses **static designs** (JPG, PNG, WEBP, PDF pages) with the **Gemini API** using `GEMINI_API_KEY`. It uses no Vertex AI, no Cloud Vision, no billing setup, and no local AI.

The Vertex AI + Cloud Vision provider (`google`), the local provider and the mock are unchanged.

## How it works

- **One call per design.** `GeminiProvider.analyzeDesign` sends a single `generateContent` request to `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`. The request contains:
  - the prepared design image (at most 2,048 px; a copy, never the original file or its name);
  - the company's saved logo, if any;
  - as **data**: the session's **confirmed** requirements and the company's saved rules (Golden Rules, brand colours, fonts, approved and banned terms). No contact details and no unconfirmed requirements are sent.
- **What comes back.** One JSON answer under a strict schema: every text line with its box, role, font, bold and certainty, plus logo, focal point, image issues and colour-only meaning. `validateDesignAnalysis` checks it strictly and splits it into the same text blocks and judgement the other providers produce. Assembly, the Phase 5 rules, Phase 7 scoring and the Phase 8 report then run unchanged.
- **Colours are still measured** from the image's pixels, inside the boxes Gemini gives (see *Bounding boxes* below when a box is missing or invalid).
- **Information files** that are images or scanned pages use a text-only call (`readText`, format `gemini-v1`). Requirement extraction uses `extractRequirements`. Video is refused, because only static designs are supported.
- **The key** is sent in the `x-goog-api-key` header, never in a URL. It is never logged or printed. Raw answers are never stored.

## Bounding boxes (positions) are optional

Gemini sometimes returns a wrong box. For example, on one test design both `gemini-3.5-flash-lite` and `gemini-3.8-flash` returned every text line with its vertical coordinates negated. So that one bad box can't fail the whole analysis, boxes are optional. This applies to text-line boxes (`box_2d`), the logo box and the focal point:

| Box | What happens |
|---|---|
| Valid (four whole numbers 0–1000, top above bottom, left before right) | Kept as is |
| Slightly out of range (within 10 of the 0–1000 scale, e.g. −2 or 1004) | Clamped to 0–1000 by the provider (`clampGeminiCoordinates`), then kept |
| Clearly invalid (far out of range, not a number, wrong length, impossible) or missing | **Discarded on its own.** It is never sign-flipped, repaired or guessed. The text line is kept, without a position or size. An invalid logo box becomes `null` (logo presence and match are still used). An invalid focal point is dropped |

**What a missing box means for the checks:**
- A line without a box has no position, font size or measured colour.
- The checks that need positions or sizes are never passed on partial data. If any line has no box, *Overlapping text*, *Text near the edge* and *Text size* are **not verified**, with the explanation "the position or size of some text couldn't be read". They are never shown as passed.
- *Text contrast* skips lines without colours, and *Rule of Thirds* is not verified without a focal point.
- Text checks (brief requirements, Golden Rules, banned terms, placeholders, contact details…) work as normal, because the text itself is kept.
- The QC result, score and PDF report still work.

**Everything else stays strict.** An invalid box never excuses any other field. The answer is still rejected for:
- an unknown field;
- a bad role or certainty;
- text that is too long, or too many lines or fonts;
- a bad logo field (`present`, `matchesCompanyLogo`) or focal-point certainty;
- an unknown image issue or a malformed colour-only answer.

**Gemini only.** This behaviour is in the Gemini parts of `validate.ts` (`validateDesignAnalysis`, `validateGeminiText`) and the Gemini profile of the confidence policy. The OCR providers (Google Cloud Vision, local) always measure a box for every line and are unchanged. So are the Phase 5 rules, Phase 7 scoring and the Phase 8 report.

## Safety: AI uncertainty never makes a counting CRITICAL

There is no OCR engine on this route, so everything Gemini reports is **AI evidence** (`policy.ts`, `{ provider: "gemini" }`):

| Finding | Result |
|---|---|
| Anything CRITICAL from Gemini's reading (wrong price, missing disclaimer, wrong logo…) | **"Needs a human check — possible critical issue"** (never counted) |
| MAJOR / MINOR | Counts only when Gemini said **clear**; "likely" or "unsure" becomes "Needs a human check" |
| A "no problem found" pass (image quality, colour-only meaning, fonts, headline) | **Not verified** |
| File measurements (Platform / Size) | Measured; count as before |

So a design Gemini reads with the wrong price is **not a FAIL**: the result asks for a human check. This is safe but less decisive than a measured OCR engine.

## Settings (server only; put them in `<home>/.skybook-qc/.env.local`, never in the project folder)

```
QC_ANALYSIS_PROVIDER=gemini
GEMINI_API_KEY=...            # from Google AI Studio; never paste it in chat or commit it
# QC_GEMINI_MODEL=gemini-3.8-flash
```

`gemini-3.8-flash` is listed on the Gemini API **free tier** (pricing page checked 2026-10-06). `gemini-3.5-flash-lite` can be set as an alternative.

**Limits (`GEMINI_LIMITS`):**
- one design at a time and one call per design;
- 120 s per call;
- rate-limit answers (429) are retried after `Retry-After`.

Free-tier daily and per-minute limits are shown in AI Studio for your project.

## Smoke test (opt-in)

```
npm run qc:smoke:gemini -- --yes-call-gemini
```

This makes one call on a synthetic design and uses one request of the free quota. It prints PASS / FAIL, counts and timing only. It is not part of `npm test`; the normal tests use recorded answers and need no key.

## Limitations

- **Free-tier data use.** Google may use what is sent on the free tier to improve its products, and human reviewers may read it. Google's terms say not to send confidential information. Use synthetic or non-confidential designs until this is accepted, or move to a paid tier later. Designers are told on the Start QC page: when the provider is `gemini`, a "Gemini free tier — check what you upload." notice appears directly above "4. Upload Information", before any file can be sent (`components/qc/gemini-free-tier-notice.tsx`). It isn't shown for the mock, local or Google providers.
- **No EU data region.** The Gemini API has no region setting, unlike the Vertex provider's EU endpoint.
- **Gemini can misread text.** Because the client's requirements are part of the prompt, it could also be biased toward the expected value. The prompt forbids copying from the list, but a PASS on a requirement is still an AI reading, so check important values yourself.
- **Free-tier quotas are low.** A busy day may hit the limit; runs then fail with "the free-tier limit was reached". Try again later.
- **Report label.** The PDF report (Phase 8, unchanged) doesn't name the provider. The Start QC page shows "Gemini (Google AI Studio)" and a notice on the checks.
