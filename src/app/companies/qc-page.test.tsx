import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const latestBriefOutcome = vi.fn();
const latestDoneRun = vi.fn();

vi.mock("@/lib/company/access", () => ({ requireCompanyAccess }));
vi.mock("@/lib/db/client", () => ({ getDatabase: () => ({}) }));
vi.mock("@/lib/db/company-config", () => ({ loadCompanyConfiguration }));
vi.mock("@/lib/db/qc-sessions", () => ({ findCurrentSession, listRequirements, listFiles }));
vi.mock("@/lib/storage/qc-storage", () => ({ getQcStorage }));
vi.mock("@/lib/db/analysis-runs", () => ({ latestRun, latestDetections, countRuns, latestBriefOutcome, latestDoneRun }));
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
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), usePathname: () => "/" }));

const { default: StartQcPage } = await import("@/app/companies/[companyId]/qc/new/page");

const ID = "0b6d0f0e-8c1a-4a57-9a4e-2a6f1d6c9e01";
const SESSION = "5b6d0f0e-8c1a-4a57-9a4e-2a6f1d6c9e02";
const user = { id: "u1", name: "Dee Designer", email: "dee@skybook.com", role: "designer", active: true };
const now = new Date();
const company = { id: ID, name: "Acme Properties", active: true };
const props = { params: Promise.resolve({ companyId: ID }), searchParams: Promise.resolve({}) };
const emptyConfig = {
  company,
  contact: { phone: null, additional_phone: null, whatsapp: null, email: null, website: null },
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

/** A design check in progress (the result section appears once a check has started). */
const checking = {
  id: "run1", session_id: "s1", requested_by: "u1", kind: "content", provider: "mock", status: "processing", stage: "Reading text",
  progress_done: 1, progress_total: 4, attempts: 1, files_fingerprint: "x", analysed_share: null, failure_reason: null,
  created_at: new Date(), started_at: new Date(), heartbeat_at: new Date(), finished_at: null,
};
const visible = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

const main = (html: string) => html.slice(html.indexOf("<main"), html.indexOf("</main>"));
/** The visible result banner (the section description names the results, so match the banner itself). */
const NO_RESULT_BANNER = /QC result: |\/ 100|No issues to fix|Fix the issues below|at least one critical issue/;

describe("Start QC page", () => {
  beforeEach(() => {
    delete process.env.QC_ANALYSIS_PROVIDER;
    latestRun.mockReset().mockResolvedValue(null);
    latestDetections.mockReset().mockResolvedValue(null);
    countRuns.mockReset().mockResolvedValue(0);
    latestBriefOutcome.mockReset().mockResolvedValue(null);
    // The newest successful run of a kind: the test's own newest run, when it finished.
    latestDoneRun.mockReset().mockImplementation(async (...args: unknown[]) => {
      const run = await latestRun(...args);
      return run?.status === "done" ? run : null;
    });
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

  it("without a session: one Start QC button — no content-type question (new checks are Design / Poster)", async () => {
    const html = main(renderToStaticMarkup(await StartQcPage(props)));
    expect(html).toContain("Start QC");
    expect(html).toContain('name="contentType" value="design_poster"');
    expect(html).not.toMatch(/type="radio"/);
    for (const label of ["What are you checking?", "Social Media Post", "Reel / Short", "YouTube Video"]) {
      expect(html, label).not.toContain(label);
    }
  });

  describe("Gemini free tier privacy notice", () => {
    const NOTICE_TITLE = "Gemini free tier — check what you upload.";
    const NOTICE_TEXT =
      "Designs, uploaded brief files and typed or pasted brief text you analyse here are sent to Google&#x27;s Gemini API, together with your confirmed requirements and this company&#x27;s brand rules. On the free tier, Google may use what is sent to improve its products, and human reviewers may read it. Don&#x27;t upload, type or paste confidential client material. Gemini has no EU data region.";
    const page = async (provider: string) => {
      process.env.QC_ANALYSIS_PROVIDER = provider;
      findCurrentSession.mockResolvedValue(session());
      return main(renderToStaticMarkup(await StartQcPage(props)));
    };

    it("Gemini → the notice is shown, with the exact text, directly above 1. Add client brief", async () => {
      const html = await page("gemini");
      expect(html).toContain(NOTICE_TITLE);
      expect(html).toContain(NOTICE_TEXT);
      expect(html.match(/aria-label="Gemini free tier privacy notice"/g)).toHaveLength(1);
      // Placement: before anything is uploaded, immediately before 1. Add client brief.
      expect(visible(html).indexOf(NOTICE_TITLE)).toBeLessThan(visible(html).indexOf("1. Add client brief"));
      // The notice is the element right before the brief upload section.
      expect(html).toMatch(/Gemini has no EU data region\.<\/p><\/div><\/aside><section id="information"/);
    });

    for (const provider of ["mock", "local", "google"]) {
      it(`${provider} → the notice is hidden`, async () => {
        const html = await page(provider);
        expect(html).not.toContain(NOTICE_TITLE);
        expect(html).not.toContain("Gemini free tier privacy notice");
        expect(visible(html)).toContain("1. Add client brief"); // the page itself is unchanged
      });
    }

    it("no provider configured → hidden too", async () => {
      findCurrentSession.mockResolvedValue(session());
      const html = main(renderToStaticMarkup(await StartQcPage(props)));
      expect(html).not.toContain(NOTICE_TITLE);
    });
  });

  describe("Local AI's reading limit (Stage 2 follow-up)", () => {
    const page = async (provider: string, profile?: string) => {
      process.env.QC_ANALYSIS_PROVIDER = provider;
      if (profile) process.env.QC_LOCAL_PROFILE = profile;
      else delete process.env.QC_LOCAL_PROFILE;
      findCurrentSession.mockResolvedValue(session());
      return visible(main(renderToStaticMarkup(await StartQcPage(props))));
    };
    afterEach(() => {
      delete process.env.QC_LOCAL_PROFILE;
    });

    it("Local AI → a warning in step 1, before the uploads, with the number of characters it reads", async () => {
      const text = await page("local");
      const note =
        "Local AI reads only the first 12,000 characters of each brief file or typed brief. If a brief is longer, split it into separate files or typed parts so nothing is missed.";
      expect(text).toContain(note);
      expect(text.indexOf("1. Add client brief")).toBeLessThan(text.indexOf(note));
      expect(text.indexOf(note)).toBeLessThan(text.indexOf("Upload brief"));
      expect(await page("local", "gpu")).toContain("Local AI reads only the first 30,000 characters");
    });

    for (const provider of ["gemini", "mock", "google"]) {
      it(`${provider} → no warning (the page is unchanged)`, async () => {
        expect(await page(provider)).not.toContain("Local AI reads only");
      });
    }
  });

  it("brief too long for Local AI (Stage 2 hold): the message is shown under Check Design, which stays off", async () => {
    const message =
      "Too long for Local AI to read in full: brief.pdf (15,230 characters). Local AI reads up to 12,000 characters per brief file — shorten it, or split it into smaller files and upload them separately.";
    latestBriefOutcome.mockResolvedValue({ status: "failed", failure_reason: message });
    findCurrentSession.mockResolvedValue(session());
    const html = main(renderToStaticMarkup(await StartQcPage(props)));
    expect(visible(html)).toContain(message);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Check Design<\/button>/);
    expect(latestBriefOutcome).toHaveBeenCalledWith(expect.anything(), expect.any(String), "Too long for Local AI to read in full");
  });

  it("with a session: upload the brief, upload the design, Check Design — nothing else to fill in", async () => {
    findCurrentSession.mockResolvedValue(session());
    const html = main(renderToStaticMarkup(await StartQcPage(props)));
    const text = visible(html);
    expect(text.indexOf("1. Add client brief")).toBeGreaterThan(-1);
    expect(text.indexOf("1. Add client brief")).toBeLessThan(text.indexOf("2. Upload design"));
    expect(text.indexOf("2. Upload design")).toBeLessThan(text.indexOf("3. Check design"));
    expect(text).toContain("Upload brief");
    // Stage 2: the brief can also be typed or pasted, in the same step, before the design.
    expect(text.indexOf("Enter brief text")).toBeGreaterThan(text.indexOf("Upload brief"));
    expect(text.indexOf("Enter brief text")).toBeLessThan(text.indexOf("2. Upload design"));
    expect(text).toContain("Upload design");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Check Design<\/button>/); // nothing uploaded yet
    for (const gone of ["What are you checking?", "Requirements", "Confirm & Run QC", "Save and continue", "Find requirements", "Analyse now", "Draft"]) {
      expect(text, gone).not.toContain(gone);
    }
    expect(html).not.toContain('id="platform"'); // asked only when the brief, once read, gives no exact size
    expect(html).not.toContain('id="qc-result"'); // no result before a check
    expect(text).toContain("Deleted automatically in 24 hours");
    // The design upload accepts only what the content type allows.
    expect(html).toContain('accept=".jpg,.jpeg,image/jpeg,.png,image/png,.webp,image/webp,.pdf,application/pdf"');
  });

  it("an existing video session (from before video was hidden) still opens and accepts only video content", async () => {
    findCurrentSession.mockResolvedValue(session({ content_type: "reel_short" }));
    const html = main(renderToStaticMarkup(await StartQcPage(props)));
    expect(html).toContain('accept=".mp4,video/mp4,.mov,video/quicktime,.webm,video/webm"');
    expect(html).toContain("MP4, MOV, WEBM · up to 1 file");
  });

  it("the requirements read from the brief are never shown or edited — no types, Must have / Optional or editor", async () => {
    findCurrentSession.mockResolvedValue(session());
    listRequirements.mockResolvedValue([
      { id: "r1", type: "offer", label: null, expected_value: "20% discount", notes: "Summer only", mandatory: true, confirmed: false, source: "extracted" },
      { id: "r2", type: "cta", label: null, expected_value: "Book now", notes: null, mandatory: false, confirmed: true, source: "extracted" },
    ]);
    // The platform step is itself labelled "optional"; leave it out here.
    const html = main(renderToStaticMarkup(await StartQcPage(props))).replace(/<section id="platform"[\s\S]*?<\/section>/, "");
    for (const hidden of ["20% discount", "Must have", "Optional", "Requirement type", "Add requirement", "Needs review"]) {
      expect(html, hidden).not.toContain(hidden);
    }
    expect(html).not.toMatch(/Edit<\/button>|Delete<\/button>/);
  });

  it("the optional platform is offered only when the brief gives no exact size", async () => {
    findCurrentSession.mockResolvedValue(session());
    const req = (type: string, value: string) => ({ id: type, type, label: null, expected_value: value, notes: null, mandatory: true, confirmed: false, source: "extracted" });
    listRequirements.mockResolvedValue([req("price", "AED 99"), req("dimensions", "1080 × 1080 px")]);
    expect(main(renderToStaticMarkup(await StartQcPage(props)))).not.toContain('id="platform"');
    listRequirements.mockResolvedValue([req("price", "AED 99")]);
    const html = main(renderToStaticMarkup(await StartQcPage(props)));
    expect(html).toContain('id="platform"');
    expect(visible(html)).toContain("Platform (optional)");
    expect(visible(html)).toContain("Without a platform, all the other checks still run and the platform checks are shown as not checked.");
    // A platform already chosen stays visible.
    findCurrentSession.mockResolvedValue(session({ platform: "instagram", placement: "feed_image" }));
    listRequirements.mockResolvedValue([req("dimensions", "1080 × 1080 px")]);
    expect(main(renderToStaticMarkup(await StartQcPage(props)))).toContain('id="platform"');
  });

  describe("reading the brief", () => {
    const briefFile = { id: "f1", kind: "information", file_name: "brief.pdf", mime_type: "application/pdf", file_size: 34_000, status: "ready" };
    const infoRun = (over = {}) => ({ ...checking, id: "i1", kind: "information", status: "done", files_fingerprint: "", ...over });
    beforeEach(async () => {
      process.env.QC_ANALYSIS_PROVIDER = "mock";
      findCurrentSession.mockResolvedValue(session());
      listFiles.mockResolvedValue([briefFile]);
      const { filesFingerprint } = await import("@/lib/analysis/pipeline");
      const done = infoRun({ files_fingerprint: filesFingerprint([briefFile]) });
      latestRun.mockImplementation(async (_db: unknown, _id: string, kind: string) => (kind === "information" ? done : null));
    });
    const page = async () => visible(main(renderToStaticMarkup(await StartQcPage(props))));
    const req = (type: string) => ({ id: type, type, label: null, expected_value: "x", notes: null, mandatory: false, confirmed: false, source: "extracted" });

    it("read and something to check: 'Brief read.'", async () => {
      listRequirements.mockResolvedValue([req("price")]);
      const text = await page();
      expect(text).toContain("Brief read.");
      expect(text).not.toContain("We couldn't find clear requirements");
    });

    it("read but nothing checkable (or only descriptive items): the clearer-brief message, and Check Design waits", async () => {
      for (const found of [[], [req("campaign_name"), req("special_instruction"), req("target_audience"), req("other")]]) {
        listRequirements.mockResolvedValue(found);
        const text = await page();
        expect(text.match(/We couldn't find clear requirements in this brief\. Please upload a clearer brief\./g)?.length).toBeGreaterThanOrEqual(1);
        expect(text).not.toContain("Brief read.");
      }
    });

    it("couldn't be read: the clearer-brief message with the reason, and Try again", async () => {
      latestRun.mockImplementation(async (_db: unknown, _id: string, kind: string) =>
        kind === "information" ? infoRun({ status: "failed", failure_reason: "the file couldn't be read" }) : null
      );
      const text = await page();
      expect(text).toContain("We couldn't find clear requirements in this brief. Please upload a clearer brief. (the file couldn't be read)");
      expect(text).toContain("Try again");
    });

    it("being read: says so, and Check Design waits for it", async () => {
      latestRun.mockImplementation(async (_db: unknown, _id: string, kind: string) => (kind === "information" ? infoRun({ status: "processing" }) : null));
      const text = await page();
      expect(text).toContain("Reading the brief…");
      expect(text).toContain("The brief is still being read");
    });

    it("the count is what the brief reading found: manually entered requirements don't make it 'Brief read.'", async () => {
      listRequirements.mockResolvedValue([{ ...req("price"), source: "manual", confirmed: true }]);
      const text = await page();
      expect(text).toContain("We couldn't find clear requirements in this brief. Please upload a clearer brief.");
      expect(text).not.toContain("Brief read.");
    });

    it("the brief changed since its last successful reading (a newer one failed): Check Design waits until it's read again", async () => {
      const { filesFingerprint } = await import("@/lib/analysis/pipeline");
      const newFile = { ...briefFile, id: "f9", file_name: "new brief.pdf" };
      listFiles.mockResolvedValue([briefFile, newFile]);
      listRequirements.mockResolvedValue([req("price")]);
      const failed = infoRun({ id: "i2", status: "failed", failure_reason: "new brief.pdf: the AI couldn't read it", files_fingerprint: filesFingerprint([briefFile, newFile]) });
      latestRun.mockImplementation(async (_db: unknown, _id: string, kind: string) => (kind === "information" ? failed : null));
      latestDoneRun.mockResolvedValue(infoRun({ files_fingerprint: filesFingerprint([briefFile]) }));
      const html = main(renderToStaticMarkup(await StartQcPage(props)));
      expect(visible(html)).toContain("The current brief hasn't been read successfully yet — read it again in step 1 before checking the design.");
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Check Design<\/button>/);
    });
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
    listRequirements.mockResolvedValue([
      { id: "r1", type: "price", label: null, expected_value: "AED 1,299", notes: null, mandatory: true, confirmed: true, source: "manual", source_file_id: null, created_at: now, updated_at: now },
    ]);
    listFiles.mockResolvedValue([
      {
        id: "f2", kind: "content", file_name: "story.png", mime_type: "image/png", file_size: 900_000, status: "ready",
        media_width: 1080, media_height: 1350, media_duration_ms: null, media_dpi: null, media_pages: null, media_note: null,
      },
    ]);
    // Before Check Design: no result and no detail.
    expect(main(renderToStaticMarkup(await StartQcPage(props)))).not.toContain("Platform check");
    // While the design is being checked: the progress card in the result's place, no result and no detail yet.
    latestRun.mockImplementation(async (_db: unknown, _id: string, kind: string) => (kind === "content" ? checking : null));
    const during = visible(main(renderToStaticMarkup(await StartQcPage(props))));
    expect(during).toContain("Checking your design");
    expect(during).not.toContain("Platform check");
    // A check that didn't finish: the platform detail (measured from the file) is there, but no result.
    const failed = { ...checking, status: "failed", stage: "Failed", failure_reason: "Timed out." };
    latestRun.mockImplementation(async (_db: unknown, _id: string, kind: string) => (kind === "content" ? failed : null));
    const html = main(renderToStaticMarkup(await StartQcPage(props)));
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("Platform check");
    for (const label of ["Expected", "Detected", "Issue", "Suggested fix"]) expect(text).toContain(label);
    expect(text).toContain("9:16 (±1%)");
    expect(text).toContain("4:5 (1080 × 1350)");
    expect(text).toContain("Safe zone — not verified.");
    expect(text).toContain("Source: Meta Ads Guide");
    expect(text).toContain("No result: the check didn&#x27;t finish.");
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
    latestRun.mockImplementation(async (_db: unknown, _id: string, kind: string) => (kind === "content" ? { ...checking, status: "failed", failure_reason: "x" } : null));
    const html = main(renderToStaticMarkup(await StartQcPage(props)));
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("Content checks");
    for (const category of ["Content", "Brand", "Golden Rules", "Design &amp; Layout", "Accessibility", "Image &amp; Asset", "Brief", "Legal &amp; Compliance"]) {
      expect(text, category).toContain(category);
    }
    expect(text).toContain("Golden Rule: Always use Book now");
    expect(text).toContain("Expected: AED 1,299");
    expect(text).toMatch(/\d+ checks not verified/);
    expect(text).toContain("The analysis didn&#x27;t finish (x)");
    expect(text).not.toContain("To fix");
    expect(text).not.toMatch(/\d+ passed/);
  });

  it("before anything is uploaded: no checks, and Check Design says what's missing", async () => {
    findCurrentSession.mockResolvedValue(session());
    const text = visible(main(renderToStaticMarkup(await StartQcPage(props))));
    expect(text).not.toContain("Platform check");
    expect(text).not.toContain("Content checks");
    expect(text).toContain("· Upload or type the client brief. · Upload the design.");
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
    expect(text).toContain("Check Design");
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
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ");

    const confirmedRequirement = {
      id: "q1", type: "required_text", label: null, expected_value: "Sample headline", notes: null, mandatory: false, confirmed: true,
      source: "manual", source_file_id: null, created_at: now, updated_at: now,
    };
    const mockDetections = async () => {
      const { filesFingerprint } = await import("@/lib/analysis/pipeline");
      latestRun.mockResolvedValue(runRow({ status: "done", stage: "Finished", progress_done: 4 }));
      latestDetections.mockResolvedValue({
        runId: "r1",
        provider: "mock",
        fingerprint: filesFingerprint([contentFile]),
        detections: { source: "mock", frame: { width: 1080, height: 1350 }, texts: [{ text: "Sample headline", confidence: 0.95, fileId: "f2" }], textCoverage: 0.95 },
      });
    };

    beforeEach(() => {
      process.env.QC_ANALYSIS_PROVIDER = "mock";
      findCurrentSession.mockResolvedValue(session({ platform: "instagram", placement: "feed_image" }));
      listFiles.mockResolvedValue([contentFile]);
      listRequirements.mockResolvedValue([confirmedRequirement]);
    });

    it("runs left counts design analyses only: with all 5 used, the brief can still be read again", async () => {
      listFiles.mockResolvedValue([contentFile, { id: "f1", kind: "information", file_name: "brief.txt", mime_type: "text/plain", file_size: 100, status: "ready" }]);
      await mockDetections();
      countRuns.mockResolvedValue(5);
      const text = await page();
      expect(countRuns).toHaveBeenCalledWith(expect.anything(), SESSION, "content");
      // The way forward is said plainly: Start over, and what it deletes.
      expect(text).toContain("This check has used all its analysis runs. To check again, press Start over (next to Check Design): it deletes this check's brief, design and result (your company details stay), then upload them again.");
      expect(text.match(/used all its analysis runs/g)).toHaveLength(1); // the design panel only
      expect(text).toContain("Read again");
      expect(text).not.toContain("Analyse again");
    });

    it("analysed, but no confirmed requirement: no PASS — the page asks for the requirements instead", async () => {
      listRequirements.mockResolvedValue([]);
      await mockDetections();
      const text = await page();
      expect(text).toContain("Add or confirm the client's requirements before running QC.");
      expect(text).not.toMatch(NO_RESULT_BANNER);
      expect(text).not.toContain("PASS");
      expect(text).not.toContain("Download QC report");
      // Unconfirmed ones don't count either.
      listRequirements.mockResolvedValue([{ ...confirmedRequirement, confirmed: false }]);
      expect(await page()).not.toMatch(NO_RESULT_BANNER);
      // With a confirmed requirement the result is shown as before.
      listRequirements.mockResolvedValue([confirmedRequirement]);
      expect(await page()).toMatch(NO_RESULT_BANNER);
    });

    it("not checked yet: Check Design is the way to start; no result yet", async () => {
      const text = await page();
      expect(text).toContain("Check Design");
      expect(text).not.toContain("Checking the design");
      expect(text).not.toMatch(NO_RESULT_BANNER);
    });

    it("in progress: a progress card in the result's place — the step it's on, how long to expect, the mock label; no result yet", async () => {
      latestRun.mockResolvedValue(runRow());
      const text = await page();
      const card = text.slice(text.indexOf("Checking your design"));
      expect(card).toMatch(/^Checking your design Sample data: a few seconds\. You can stay on this page — the result appears here by itself\./);
      // Steps 1–2 done, 3 under way (by name), 4 to come; then the line under the bar.
      expect(card).toContain("Step 1 Step 2 Step 3: Reading text Step 4");
      expect(card).toContain("Step 3 of 4: Reading text Sample data — not real AI");
      expect(text).not.toMatch(NO_RESULT_BANNER);
      expect(text).not.toContain("Download QC report");
      expect(text).not.toContain("All checks in detail");
      expect(text).not.toContain("The result appears when the analysis finishes.");
    });

    it("failed: the plain reason and Try again", async () => {
      latestRun.mockResolvedValue(runRow({ status: "failed", stage: "Failed", failure_reason: "The text reader timed out." }));
      const text = await page();
      expect(text).toContain("The check didn't finish: The text reader timed out.");
      expect(text).toContain("Try again");
      expect(text).toContain("The analysis didn't finish (The text reader timed out)");
    });

    it("done with mock results: labelled everywhere; uncertain findings are items to verify", async () => {
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
      expect(text).toContain("Design checked — the result is below.");
      expect(text).toContain("Sample data — not real AI. These results come from the test provider");
      expect(text).toContain("to verify — the AI wasn't sure enough for it to count. Please check it by eye before sending the content.");
      // Phase 7: the result — labelled as sample data; uncounted checks said plainly.
      // No counted issues but a human check → the banner says so (the result itself is still PASS).
      expect(text).toContain("Result · Score 100 / 100 PASS — PLEASE VERIFY No issues found — but please verify the items marked below before sending it to the client.");
      expect(text).toContain("Sample data — not real AI. This is not a real QC result.");
      // The simplified summary: three counts, short sections, passed checks collapsed into one line.
      expect(text).toContain("0 Issues to fix 1 To verify 11 Checks passed"); // 10 + the confirmed requirement found
      expect(text).toContain("Issues to fix 0 No issues to fix.");
      expect(text).toContain("1 optional suggestion Recommended resolution — Export at 1440 × 1800 if the original artwork allows it.");
      expect(text).toContain("Items to verify 1 Please check these by eye before sending. They don't count for or against the result. Check Brief / rule says Design shows Status Brand fonts Major Brand Brief / rule says Montserrat Design shows Sample Sans Check Check the design for \"Montserrat\" — the AI wasn't sure. ? Verify");
      expect(text).not.toMatch(/HUMAN CHECK REQUIRED|Human checks?\b|Should be|AI read/);
      expect(text).toContain("Passed 11 ✓ 11 checks passed");
      // Technical wording stays out of the summary: it is only in "All checks in detail", after the download.
      const summary = text.slice(text.indexOf("Result · Score"), text.indexOf("All checks in detail"));
      expect(summary).not.toMatch(/not verified|Needs a human check:|Detected:|couldn't be verified/);
      // The small "Score by category" card sits under the design, after the summary strip (scores only).
      const strip = text.slice(text.indexOf("Result · Score"), text.indexOf("Download QC report"));
      expect(strip).not.toContain("Score by category");
      expect(text.indexOf("Score by category")).toBeGreaterThan(text.indexOf("Download QC report"));
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
      expect(await page()).toContain("The design has changed since it was checked");
    });
  });
});
