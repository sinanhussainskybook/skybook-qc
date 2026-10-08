import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/** The Start QC page (Phase 4 — Requirements + Upload). */

const requireCompanyAccess = vi.fn();
const findCurrentSession = vi.fn();
const listRequirements = vi.fn();
const listFiles = vi.fn();
const loadCompanyConfiguration = vi.fn();
const purgeExpiredSessions = vi.fn();
const getQcStorage = vi.fn();
const latestRun = vi.fn();
const latestDetections = vi.fn();
const countRuns = vi.fn();

vi.mock("@/lib/company/access", () => ({ requireCompanyAccess }));
vi.mock("@/lib/db/client", () => ({ getDatabase: () => ({}) }));
vi.mock("@/lib/db/company-config", () => ({ loadCompanyConfiguration }));
vi.mock("@/lib/db/qc-sessions", () => ({ findCurrentSession, listRequirements, listFiles }));
vi.mock("@/lib/storage/qc-storage", () => ({ getQcStorage }));
vi.mock("@/lib/db/analysis-runs", () => ({ latestRun, latestDetections, countRuns }));
vi.mock("@/lib/qc/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/qc/session")>()),
  purgeExpiredSessions,
}));
vi.mock("@/lib/auth/actions", () => ({ signOutAction: vi.fn() }));
vi.mock("@/lib/qc/actions", () => ({
  startSessionAction: vi.fn(),
  startOverAction: vi.fn(),
  changeContentTypeAction: vi.fn(),
  saveRequirementAction: vi.fn(),
  setRequirementConfirmedAction: vi.fn(),
  deleteRequirementAction: vi.fn(),
  prepareUploadAction: vi.fn(),
  confirmUploadAction: vi.fn(),
  cancelUploadAction: vi.fn(),
  removeFileAction: vi.fn(),
  markReadyAction: vi.fn(),
  setPlatformAction: vi.fn(),
  startAnalysisAction: vi.fn(),
  analysisStatusAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { default: StartQcPage } = await import("@/app/companies/[companyId]/qc/new/page");

const ID = "0b6d0f0e-8c1a-4a57-9a4e-2a6f1d6c9e01";
const SESSION = "5b6d0f0e-8c1a-4a57-9a4e-2a6f1d6c9e02";
const user = { id: "u1", name: "Dee Designer", email: "dee@skybook.com", role: "designer", active: true };
const now = new Date();
const company = { id: ID, name: "Acme Properties", active: true };
const props = { params: Promise.resolve({ companyId: ID }), searchParams: Promise.resolve({}) };
const emptyConfig = {
  company,
  contact: { phone: null, whatsapp: null, email: null, website: null },
  logo: null,
  brand: { colors: [], fonts: [], terms: [] },
  goldenRules: [],
};
const session = (over = {}) => ({
  id: SESSION,
  company_id: ID,
  user_id: "u1",
  content_type: "design_poster",
  status: "draft",
  platform: null,
  placement: null,
  custom_label: null,
  custom_width: null,
  custom_height: null,
  custom_unit: null,
  custom_min_dpi: null,
  custom_max_bytes: null,
  expires_at: new Date(now.getTime() + 24 * 3_600_000),
  created_at: now,
  updated_at: now,
  ...over,
});

const main = (html: string) => html.slice(html.indexOf("<main"), html.indexOf("</main>"));
/** The visible result banner (the section description names the results, so match the banner itself). */
const NO_RESULT_BANNER = /QC result: |\/ 100|No issues to fix|Fix the issues below|at least one critical issue/;

describe("Start QC page", () => {
  beforeEach(() => {
    delete process.env.QC_ANALYSIS_PROVIDER;
    latestRun.mockReset().mockResolvedValue(null);
    latestDetections.mockReset().mockResolvedValue(null);
    countRuns.mockReset().mockResolvedValue(0);
    requireCompanyAccess.mockReset().mockResolvedValue({ user, company });
    findCurrentSession.mockReset().mockResolvedValue(null);
    listRequirements.mockReset().mockResolvedValue([]);
    listFiles.mockReset().mockResolvedValue([]);
    loadCompanyConfiguration.mockReset().mockResolvedValue(emptyConfig);
    purgeExpiredSessions.mockReset().mockResolvedValue(0);
    getQcStorage.mockReset().mockReturnValue({});
  });

  it("checks access to the company first, and stops when refused", async () => {
    await StartQcPage(props);
    expect(requireCompanyAccess).toHaveBeenCalledWith(ID);
    requireCompanyAccess.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(StartQcPage(props)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(findCurrentSession).toHaveBeenCalledTimes(1);
  });

  it("clears expired sessions before showing the page", async () => {
    await StartQcPage(props);
    expect(purgeExpiredSessions).toHaveBeenCalled();
  });

  it("without a session: asks what's being checked, offering the static design types only", async () => {
    const html = main(renderToStaticMarkup(await StartQcPage(props)));
    for (const label of ["Design / Poster", "Social Media Post"]) {
      expect(html, label).toContain(label);
    }
    // Video types are kept in the code for later, but not offered.
    for (const label of ["Reel / Short", "YouTube Video"]) {
      expect(html, label).not.toContain(label);
    }
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).toContain("Start QC");
  });

  describe("Gemini free tier privacy notice", () => {
    const NOTICE_TITLE = "Gemini free tier — check what you upload.";
    const NOTICE_TEXT =
      "Designs and information files you analyse here are sent to Google&#x27;s Gemini API, together with your confirmed requirements and this company&#x27;s brand rules. On the free tier, Google may use what is sent to improve its products, and human reviewers may read it. Don&#x27;t upload confidential client material. Gemini has no EU data region.";
    const page = async (provider: string) => {
      process.env.QC_ANALYSIS_PROVIDER = provider;
      findCurrentSession.mockResolvedValue(session());
      return main(renderToStaticMarkup(await StartQcPage(props)));
    };

    it("Gemini → the notice is shown, with the exact text, directly above 4. Upload Information", async () => {
      const html = await page("gemini");
      expect(html).toContain(NOTICE_TITLE);
      expect(html).toContain(NOTICE_TEXT);
      expect(html.match(/aria-label="Gemini free tier privacy notice"/g)).toHaveLength(1);
      // Placement: after 3. Requirements, immediately before 4. Upload Information (nothing in between).
      const notice = html.indexOf(NOTICE_TITLE);
      const requirements = html.indexOf("3. Requirements");
      const information = html.indexOf("4. Upload Information");
      expect(requirements).toBeLessThan(notice);
      expect(notice).toBeLessThan(information);
      // The notice is the element right before the "4. Upload Information" section.
      expect(html).toMatch(/Gemini has no EU data region\.<\/p><\/div><\/aside><section id="information"/);
    });

    for (const provider of ["mock", "local", "google"]) {
      it(`${provider} → the notice is hidden`, async () => {
        const html = await page(provider);
        expect(html).not.toContain(NOTICE_TITLE);
        expect(html).not.toContain("Gemini free tier privacy notice");
        expect(html).toContain("4. Upload Information"); // the page itself is unchanged
      });
    }

    it("no provider configured → hidden too", async () => {
      findCurrentSession.mockResolvedValue(session());
      const html = main(renderToStaticMarkup(await StartQcPage(props)));
      expect(html).not.toContain(NOTICE_TITLE);
    });
  });

  it("with a session: content type, requirements, Upload Information and Upload Content on one page", async () => {
    findCurrentSession.mockResolvedValue(session());
    const html = main(renderToStaticMarkup(await StartQcPage(props)));
    for (const heading of [
      "1. What are you checking?",
      "2. Platform",
      "3. Requirements",
      "4. Upload Information",
      "5. Upload Content",
    ]) {
      expect(html, heading).toContain(heading);
    }
    expect(html).not.toContain("Client Document");
    expect(html).toContain("Save and continue");
    expect(html).toContain("Deleted automatically in 24 hours");
    // Upload Content accepts only what the content type allows.
    expect(html).toContain('accept=".jpg,.jpeg,image/jpeg,.png,image/png,.webp,image/webp,.pdf,application/pdf"');
  });

  it("an existing video session (from before video was hidden) still opens and accepts only video content", async () => {
    findCurrentSession.mockResolvedValue(session({ content_type: "reel_short" }));
    const html = main(renderToStaticMarkup(await StartQcPage(props)));
    expect(html).toContain('accept=".mp4,video/mp4,.mov,video/quicktime,.webm,video/webm"');
    expect(html).toContain("MP4, MOV, WEBM · up to 1 file");
  });

  it("shows requirements with their state — unconfirmed ones clearly need review", async () => {
    findCurrentSession.mockResolvedValue(session());
    listRequirements.mockResolvedValue([
      { id: "r1", type: "offer", label: null, expected_value: "20% discount", notes: "Summer only", mandatory: true, confirmed: false, source: "manual" },
      { id: "r2", type: "cta", label: null, expected_value: "Book now", notes: null, mandatory: false, confirmed: true, source: "manual" },
    ]);
    const html = main(renderToStaticMarkup(await StartQcPage(props)));
    expect(html).toContain("20% discount");
    expect(html).toContain("Needs review");
    expect(html).toContain("Mandatory");
    expect(html).toContain("Optional");
    expect(html).toContain("Confirm or delete 1 requirement");
  });

  it("lists uploaded files by name, type and size", async () => {
    findCurrentSession.mockResolvedValue(session());
    listFiles.mockResolvedValue([
      { id: "f1", kind: "information", file_name: "brief.pdf", mime_type: "application/pdf", file_size: 34_000, status: "ready" },
      { id: "f2", kind: "content", file_name: "poster.png", mime_type: "image/png", file_size: 900_000, status: "ready" },
    ]);
    const html = main(renderToStaticMarkup(await StartQcPage(props)));
    expect(html).toContain("brief.pdf");
    expect(html).toContain("PDF · 33 KB");
    expect(html).toContain("poster.png");
    expect(html).not.toContain("Upload the content you want checked.");
  });

  it("Platform check: Expected / Detected / Issue / Suggested fix, not-verified items; no result before analysis", async () => {
    findCurrentSession.mockResolvedValue(session({ platform: "instagram", placement: "stories_image" }));
    listFiles.mockResolvedValue([
      {
        id: "f2", kind: "content", file_name: "story.png", mime_type: "image/png", file_size: 900_000, status: "ready",
        media_width: 1080, media_height: 1350, media_duration_ms: null, media_dpi: null, media_pages: null, media_note: null,
      },
    ]);
    const html = main(renderToStaticMarkup(await StartQcPage(props)));
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("Platform check");
    for (const label of ["Expected", "Detected", "Issue", "Suggested fix"]) expect(text).toContain(label);
    expect(text).toContain("9:16 (±1%)");
    expect(text).toContain("4:5 (1080 × 1350)");
    expect(text).toContain("Safe zone — not verified.");
    expect(text).toContain("Source: Meta Ads Guide");
    expect(text).toContain("No result: content analysis isn&#x27;t set up on this server.");
    expect(text).not.toMatch(NO_RESULT_BANNER);
  });

  it("Content checks: every other category listed; without content analysis they're not verified, never passed or failed", async () => {
    findCurrentSession.mockResolvedValue(session());
    loadCompanyConfiguration.mockResolvedValue({
      ...emptyConfig,
      goldenRules: [{ id: "g1", rule: "Always use Book now", category: "approved_cta", approved_value: "Book now", mandatory: true, active: true, created_at: now, updated_at: now }],
    });
    listRequirements.mockResolvedValue([
      { id: "r1", type: "price", label: null, expected_value: "AED 1,299", notes: null, mandatory: true, confirmed: true, source: "manual", source_file_id: null, created_at: now, updated_at: now },
    ]);
    listFiles.mockResolvedValue([
      {
        id: "f2", kind: "content", file_name: "post.png", mime_type: "image/png", file_size: 900_000, status: "ready",
        media_width: 1080, media_height: 1350, media_duration_ms: null, media_dpi: null, media_pages: null, media_note: null,
      },
    ]);
    const html = main(renderToStaticMarkup(await StartQcPage(props)));
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("Content checks");
    for (const category of ["Content", "Brand", "Golden Rules", "Design &amp; Layout", "Accessibility", "Image &amp; Asset", "Brief", "Legal &amp; Compliance"]) {
      expect(text, category).toContain(category);
    }
    expect(text).toContain("Golden Rule: Always use Book now");
    expect(text).toContain("Expected: AED 1,299");
    expect(text).toMatch(/\d+ checks not verified/);
    expect(text).toContain("Content analysis isn&#x27;t set up on this server");
    expect(text).not.toContain("To fix");
    expect(text).not.toMatch(/\d+ passed/);
  });

  it("no Platform check until a platform is chosen and content is uploaded", async () => {
    findCurrentSession.mockResolvedValue(session());
    const html = main(renderToStaticMarkup(await StartQcPage(props)));
    expect(html).not.toContain("Platform check");
    expect(html).not.toContain("Content checks");
    expect(html).toContain("Choose the platform the content is for.");
  });

  it("warns which company information is missing (checks will be 'not verified')", async () => {
    findCurrentSession.mockResolvedValue(session());
    const html = main(renderToStaticMarkup(await StartQcPage(props)));
    expect(html).toContain("contact details, logo, brand colours, fonts, Golden Rules");
    expect(html).toContain("not verified");
  });

  it("says when file storage isn't set up", async () => {
    findCurrentSession.mockResolvedValue(session());
    getQcStorage.mockReturnValue(null);
    expect(main(renderToStaticMarkup(await StartQcPage(props)))).toContain("File storage isn&#x27;t set up");
  });

  it("never pretends QC ran: no result or score before analysis — even when Ready", async () => {
    findCurrentSession.mockResolvedValue(session({ status: "ready" }));
    const html = main(renderToStaticMarkup(await StartQcPage(props)));
    // Visible text only (colour class names like "text-pass" aren't words on the page).
    const text = html.replace(/<[^>]+>/g, " ");
    expect(text).toContain("Ready for QC");
    expect(text).toContain("with the QC result.");
    expect(text).not.toMatch(NO_RESULT_BANNER);
  });

  describe("content analysis (Phase 6)", () => {
    const contentFile = {
      id: "f2", kind: "content", file_name: "post.png", mime_type: "image/png", file_size: 900_000, status: "ready",
      media_width: 1080, media_height: 1350, media_duration_ms: null, media_dpi: null, media_pages: null, media_note: null,
    };
    const runRow = (over = {}) => ({
      id: "r1", session_id: SESSION, requested_by: "u1", kind: "content", provider: "mock", status: "processing", stage: "Reading text",
      progress_done: 2, progress_total: 4, attempts: 1, files_fingerprint: "x", analysed_share: null, failure_reason: null,
      created_at: now, started_at: now, heartbeat_at: now, finished_at: null, ...over,
    });
    const page = async () =>
      main(renderToStaticMarkup(await StartQcPage(props)))
        .replace(/<[^>]+>/g, " ")
        .replace(/&#x27;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ");

    beforeEach(() => {
      process.env.QC_ANALYSIS_PROVIDER = "mock";
      findCurrentSession.mockResolvedValue(session({ platform: "instagram", placement: "feed_image" }));
      listFiles.mockResolvedValue([contentFile]);
    });

    it("not analysed yet: says when it happens", async () => {
      expect(await page()).toContain("analysed when you save and continue");
    });

    it("in progress: progress and the mock label; checks say they are waiting; no result yet", async () => {
      latestRun.mockResolvedValue(runRow());
      const text = await page();
      expect(text).toContain("The result appears when the analysis finishes.");
      expect(text).not.toMatch(NO_RESULT_BANNER);
      expect(text).not.toContain("Download QC report");
      expect(text).toContain("Reading text…");
      expect(text).toContain("2 of 4 steps");
      expect(text).toContain("Sample data — not real AI");
      expect(text).toContain("The content is being analysed");
    });

    it("failed: the plain reason and Try again", async () => {
      latestRun.mockResolvedValue(runRow({ status: "failed", stage: "Failed", failure_reason: "The text reader timed out." }));
      const text = await page();
      expect(text).toContain("The analysis didn't finish: The text reader timed out.");
      expect(text).toContain("Try again");
      expect(text).toContain("The analysis didn't finish (The text reader timed out)");
    });

    it("done with mock results: labelled everywhere; uncertain findings need a human check", async () => {
      const { filesFingerprint } = await import("@/lib/analysis/pipeline");
      latestRun.mockResolvedValue(runRow({ status: "done", stage: "Finished", progress_done: 4 }));
      latestDetections.mockResolvedValue({
        runId: "r1",
        provider: "mock",
        fingerprint: filesFingerprint([contentFile]),
        detections: {
          source: "mock",
          frame: { width: 1080, height: 1350 },
          texts: [{ text: "Sample headline", confidence: 0.95, fileId: "f2" }],
          textCoverage: 0.95,
          fonts: [{ family: "Sample Sans", confidence: 0.7 }],
        },
      });
      loadCompanyConfiguration.mockResolvedValue({ ...emptyConfig, brand: { ...emptyConfig.brand, fonts: [{ id: "x", family: "Montserrat", weights: null, usage: null, size_guidance: null, created_at: now, updated_at: now }] } });
      const text = await page();
      expect(text).toContain("Analysed. The results are in the checks below.");
      expect(text).toContain("Sample data — not real AI. These results come from the test provider");
      expect(text).toContain("need a human check");
      // Phase 7: the result — labelled as sample data; uncounted checks said plainly.
      // No counted issues but a human check → the banner says so (the result itself is still PASS).
      expect(text).toContain("PASS — HUMAN CHECK REQUIRED No issues to fix in the checks that could be verified — but some items need a human check before it goes to the client. 100 / 100");
      expect(text).toContain("Sample data — not real AI. This is not a real QC result.");
      // The simplified summary: three counts, short sections, passed checks collapsed into one line.
      expect(text).toContain("0 Issues to fix 1 Human check 10 Checks passed");
      expect(text).toContain("Issues to fix No issues to fix.");
      expect(text).toContain("1 optional suggestion Recommended resolution — Export at 1440 × 1800 if the original artwork allows it.");
      expect(text).toContain("Human checks The AI wasn't sure about these. They don't count for or against the result — look at each one before sending. Major Brand fonts Brand Should be Montserrat AI read Sample Sans");
      expect(text).toContain("Passed ✓ 10 checks passed");
      // Technical wording stays out of the summary: it is only in "All checks in detail", after the download.
      const summary = text.slice(text.indexOf("QC result What's wrong"), text.indexOf("All checks in detail"));
      expect(summary).not.toMatch(/not verified|Needs a human check:|Score by category|Detected:|couldn't be verified/);
      expect(text).toContain("All checks in detail Every check with its full explanation, score by category, and anything that couldn't be checked. Score by category");
      // Phase 8: the report download, made from this session and not stored.
      expect(text).toContain("Download QC report (PDF)");
      expect(text).toContain("It isn't saved anywhere — keep the file.");
    });

    it("local provider: labelled Local AI with slow wording; its 'no problem found' is not verified", async () => {
      const { filesFingerprint } = await import("@/lib/analysis/pipeline");
      process.env.QC_ANALYSIS_PROVIDER = "local";
      latestRun.mockResolvedValue(runRow({ provider: "local" }));
      expect(await page()).toContain("Local AI — runs on this server");
      expect(await page()).toContain("Local AI can take several minutes per design.");
      latestRun.mockResolvedValue(runRow({ provider: "local", status: "done", stage: "Finished", progress_done: 4 }));
      latestDetections.mockResolvedValue({
        runId: "r1",
        provider: "local",
        fingerprint: filesFingerprint([contentFile]),
        detections: { source: "ai", frame: { width: 1080, height: 1350 }, texts: [{ text: "Book now", confidence: 0.97, fileId: "f2" }], textCoverage: 0.97, imageIssues: [] },
      });
      const text = await page();
      expect(text).toContain("Checked by Local AI on this server.");
      expect(text).toContain("the local AI saw no problem here, but that isn't confirmed");
      expect(text).not.toContain("Sample data — not real AI");
    });

    it("results for different files are not used", async () => {
      latestRun.mockResolvedValue(runRow({ status: "done" }));
      latestDetections.mockResolvedValue({ runId: "r1", provider: "mock", fingerprint: "1:old", detections: { source: "mock", texts: [] } });
      expect(await page()).toContain("the files have changed since");
    });
  });
});
