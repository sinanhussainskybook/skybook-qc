import { beforeEach, describe, expect, it, vi } from "vitest";
import { scoreFindings } from "@/lib/qc/scoring";
import type { Finding } from "@/lib/qc/findings";
import { company } from "../../../test/qc-fixtures";

/** Phase 8 — the report download: only the session's owner, only with a result, never stored. */
const getCurrentUser = vi.fn();
const findCompanyForUser = vi.fn();
const findCurrentSession = vi.fn();
const loadSessionResult = vi.fn();
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser }));
vi.mock("@/lib/company/access", () => ({ findCompanyForUser }));
vi.mock("@/lib/db/client", () => ({ getDatabase: () => ({}) }));
vi.mock("@/lib/db/qc-sessions", () => ({ findCurrentSession }));
vi.mock("@/lib/qc/session-result", () => ({ loadSessionResult }));
vi.mock("@/lib/storage/logo-storage", () => ({ readStorageConfig: () => null }));

const { GET } = await import("@/app/companies/[companyId]/qc/report/route");
const call = () => GET(new Request("http://localhost/companies/c1/qc/report"), { params: Promise.resolve({ companyId: "c1" }) } as never);
const passed: Finding = { ruleId: "brief.x", category: "brief", title: "Check", severity: "major", status: "passed", kind: "fact", explanation: "ok", confidence: 1 };
const session = { id: "s1", content_type: "social_post", platform: null, placement: null };

describe("GET /companies/[companyId]/qc/report", () => {
  beforeEach(() => {
    getCurrentUser.mockReset().mockResolvedValue({ id: "u1", role: "designer" });
    findCompanyForUser.mockReset().mockResolvedValue({ id: "c1", name: "Acme Villas" });
    findCurrentSession.mockReset().mockResolvedValue(session);
    loadSessionResult.mockReset().mockResolvedValue({
      config: company({ logo: null }),
      requirements: [],
      files: [],
      findings: [passed],
      analysisView: { detections: { source: "mock" }, provider: "mock" },
      board: scoreFindings([passed]),
    });
  });

  it("signed out → 401; no access → 404; no session of THIS designer → 404; nothing analysed → 409", async () => {
    getCurrentUser.mockResolvedValueOnce(null);
    expect((await call()).status).toBe(401);
    findCompanyForUser.mockResolvedValueOnce(null);
    expect((await call()).status).toBe(404);
    findCurrentSession.mockResolvedValueOnce(null);
    expect((await call()).status).toBe(404);
    loadSessionResult.mockResolvedValueOnce({ config: company(), requirements: [], files: [], findings: [passed], analysisView: { detections: null, provider: null }, board: null });
    const notYet = await call();
    expect(notYet.status).toBe(409);
    expect(await notYet.text()).toMatch(/no QC result yet/);
    expect(findCurrentSession).toHaveBeenLastCalledWith(expect.anything(), "c1", "u1", expect.any(Date));
  });

  it("a PDF download, not cached, named after the company and date", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="skybook-qc-acme-villas-\d{4}-\d{2}-\d{2}\.pdf"$/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe("%PDF-");
    expect(Number(res.headers.get("content-length"))).toBe(bytes.length);
  });
});
