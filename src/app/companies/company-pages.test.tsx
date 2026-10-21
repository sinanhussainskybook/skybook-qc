import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CompanyConfiguration } from "@/lib/company/types";

const requireCompanyAccess = vi.fn();
const requireUser = vi.fn();
const loadCompanyConfiguration = vi.fn();
const getLogoStorage = vi.fn();
const logoImageUrl = vi.fn();

vi.mock("@/lib/company/access", () => ({ requireCompanyAccess }));
vi.mock("@/lib/storage/logo-storage", () => ({ getLogoStorage }));
vi.mock("@/lib/company/logo", () => ({ logoImageUrl }));
vi.mock("@/lib/company/logo-actions", () => ({
  uploadLogoAction: vi.fn(),
  removeLogoAction: vi.fn(),
}));
vi.mock("@/lib/auth/current-user", () => ({ requireUser }));
vi.mock("@/lib/db/company-config", () => ({ loadCompanyConfiguration }));
vi.mock("@/lib/db/client", () => ({ getDatabase: () => ({}) }));
vi.mock("@/lib/auth/actions", () => ({ signOutAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/" }));
vi.mock("@/lib/qc/actions", () => ({ startSessionAction: vi.fn(async () => ({ ok: true })), startNewCheckAction: vi.fn() }));
vi.mock("@/lib/company/delete-actions", () => ({ deleteCompanyAction: vi.fn() }));
vi.mock("@/lib/company/actions", () => ({
  createCompanyAction: vi.fn(),
  saveCompanyFieldAction: vi.fn(),
  saveListItemAction: vi.fn(),
  deleteListItemAction: vi.fn(),
  setGoldenRuleActiveAction: vi.fn(),
}));

const { default: CompanyPage } = await import("@/app/companies/[companyId]/page");
const { default: NewCompanyPage } = await import("@/app/companies/new/page");
const { default: CompanyNotFound } = await import("@/app/companies/[companyId]/not-found");

const ID = "0b6d0f0e-8c1a-4a57-9a4e-2a6f1d6c9e01";
const user = { id: "u1", name: "Dee Designer", email: "dee@skybook.com", role: "designer", active: true };
const now = new Date();
const company = {
  id: ID,
  name: "Acme Properties",
  description: "Luxury apartments.",
  category: "Real estate",
  country: "UAE",
  city: "Dubai",
  address: null,
  active: true,
  created_at: now,
  updated_at: now,
};

const config: CompanyConfiguration = {
  company,
  contact: { phone: "+971 4 123 4567", additional_phone: "+971 4 765 4321", whatsapp: null, email: "hello@acme.com", website: "https://acme.com" },
  logo: null,
  brand: {
    tone: "Warm and confident.",
    capitalization_rules: null,
    naming_conventions: null,
    logo_rules: null,
    template_notes: null,
    other_guidelines: null,
    colors: [{ id: "k1", name: "Sky Blue", hex: "#1A64B4", cmyk: null, usage: null, created_at: now, updated_at: now }],
    fonts: [{ id: "f1", family: "Montserrat", weights: "Bold 700", usage: null, size_guidance: null, created_at: now, updated_at: now }],
    terms: [{ id: "t1", term: "Sky book", kind: "banned", note: null, created_at: now, updated_at: now }],
  },
  goldenRules: [
    { id: "r1", rule: "Show the licence number", category: "mandatory_disclaimer", approved_value: "RERA 12345", mandatory: true, active: true, created_at: now, updated_at: now },
    { id: "r2", rule: "Prefer the short CTA", category: "approved_cta", approved_value: null, mandatory: false, active: false, created_at: now, updated_at: now },
  ],
};

const props = {
  params: Promise.resolve({ companyId: ID }),
  searchParams: Promise.resolve({}),
};

describe("company page", () => {
  beforeEach(() => {
    requireCompanyAccess.mockReset().mockResolvedValue({ user, company });
    loadCompanyConfiguration.mockReset().mockResolvedValue(config);
    getLogoStorage.mockReset().mockReturnValue({});
    logoImageUrl.mockReset().mockResolvedValue(null);
  });

  it("checks access to this company on the server first", async () => {
    await CompanyPage(props);
    expect(requireCompanyAccess).toHaveBeenCalledWith(ID);
  });

  it("stops (not found / sign-in) when access is refused", async () => {
    requireCompanyAccess.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(CompanyPage(props)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(loadCompanyConfiguration).not.toHaveBeenCalled();
  });

  it("shows every section with saved values and an Edit for each field", async () => {
    const html = renderToStaticMarkup(await CompanyPage(props));
    for (const heading of ["Company information", "Contact information", "Logo", "Brand guidelines", "Golden Rules"]) {
      expect(html, heading).toContain(heading);
    }
    for (const label of ["Company name", "Description", "Company type / category", "Country", "City", "Address", "Phone", "Additional phone", "WhatsApp", "Email", "Website", "Brand tone / voice"]) {
      expect(html, label).toContain(`aria-label="Edit ${label}"`);
    }
    expect(html).toContain("+971 4 123 4567");
    expect(html).toContain("+971 4 765 4321"); // both numbers shown
    expect(html).toContain("Warm and confident.");
    expect(html).toContain("Not set");
  });

  it("shows brand colours with RGB worked out, fonts and banned terms", async () => {
    const html = renderToStaticMarkup(await CompanyPage(props));
    expect(html).toContain("HEX #1A64B4 · RGB 26, 100, 180");
    expect(html).toContain("Montserrat");
    expect(html).toContain("Banned");
  });

  it("marks mandatory and switched-off Golden Rules clearly", async () => {
    const html = renderToStaticMarkup(await CompanyPage(props));
    expect(html).toContain("Mandatory");
    expect(html).toContain("Not mandatory");
    expect(html).toContain("Switched off");
    expect(html).toContain("Switch on");
    expect(html).toContain("Approved value: </span>RERA 12345");
    expect(html).toContain("1 switched on, 1 of them mandatory");
  });

  describe("logo (D3)", () => {
    const logoSection = (html: string) =>
      html.slice(html.indexOf('id="logos"'), html.indexOf('id="brand"'));

    it("shows the empty state with Upload when there's no logo", async () => {
      const html = logoSection(renderToStaticMarkup(await CompanyPage(props)));
      expect(html).toContain("No logo yet");
      expect(html).toContain("Upload logo");
      expect(html).not.toContain("Remove");
      expect(html).not.toContain("isn&#x27;t set up");
    });

    it("shows the current logo through the server-made link, with its details", async () => {
      loadCompanyConfiguration.mockResolvedValue({
        ...config,
        logo: {
          id: "l1",
          file_name: "Acme logo.png",
          storage_path: `${ID}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`,
          mime_type: "image/png",
          file_size: 35_000,
          created_at: now,
          updated_at: now,
        },
      });
      logoImageUrl.mockResolvedValue("https://abc.supabase.co/storage/v1/object/sign/company-logos/x.png?token=t");
      const html = logoSection(renderToStaticMarkup(await CompanyPage(props)));
      expect(html).toContain('src="https://abc.supabase.co/storage/v1/object/sign/company-logos/x.png?token=t"');
      expect(html).toContain('alt="Current logo: Acme logo.png"');
      expect(html).toContain("PNG");
      expect(html).toContain("34 KB");
      expect(html).toContain("Replace logo");
      expect(html).toContain("Remove");
      expect(html).not.toContain(`${ID}/aaaaaaaa`); // the storage path itself is never sent
    });

    it("says so when logo storage isn't set up on the server", async () => {
      getLogoStorage.mockReturnValue(null);
      const html = logoSection(renderToStaticMarkup(await CompanyPage(props)));
      expect(html).toContain("isn&#x27;t set up on this server yet");
    });
  });

  it("leads with one action — Start a QC check (it starts the check for this company) — and folds the settings away", async () => {
    const html = renderToStaticMarkup(await CompanyPage(props));
    expect(html).toContain("Start a QC check");
    expect(html).toContain(`name="companyId" value="${ID}"`);
    expect(html).toContain('name="contentType" value="design_poster"');
    // Settings are still all there, in one collapsed "Company settings" area after the action.
    expect(html.indexOf("Start a QC check")).toBeLessThan(html.indexOf("Company settings"));
    expect(html).toMatch(/<details id="settings"[^>]*>/);
    expect(html).not.toMatch(/<details id="settings"[^>]*open/);
  });

  it("Start a QC check is the only action — no Continue option (a completed check is never reopened)", async () => {
    const html = renderToStaticMarkup(await CompanyPage(props));
    expect(html.match(/Start a QC check/g)).toHaveLength(1);
    expect(html).not.toContain("Continue QC check");
    expect(html).not.toContain("Start a new check"); // only after the server says the last check is complete
  });

  it("offers Delete company to administrators only (the action checks the role again)", async () => {
    expect(renderToStaticMarkup(await CompanyPage(props))).not.toContain("Delete company");
    requireCompanyAccess.mockResolvedValue({ user: { ...user, role: "admin" }, company });
    const html = renderToStaticMarkup(await CompanyPage(props));
    expect(html).toContain("Delete company");
    expect(html.indexOf("Company settings")).toBeLessThan(html.indexOf("Delete company"));
  });
});

describe("Add company page", () => {
  it("requires sign-in", async () => {
    requireUser.mockReset().mockRejectedValue(new Error("NEXT_REDIRECT /login"));
    await expect(NewCompanyPage()).rejects.toThrow("NEXT_REDIRECT /login");
  });

  it("asks only for the company name", async () => {
    requireUser.mockReset().mockResolvedValue(user);
    const html = renderToStaticMarkup(await NewCompanyPage());
    expect(html).toContain('name="name"');
    expect(html.match(/<input/g)).toHaveLength(1);
    expect(html).toContain("Add company");
  });
});

describe("company not found", () => {
  it("gives the same message whether the company is missing or not yours", () => {
    const html = renderToStaticMarkup(<CompanyNotFound />);
    expect(html).toContain("Company not found");
    expect(html).toContain("you haven&#x27;t been given access");
  });
});
