import { describe, expect, it } from "vitest";
import { parsePlatformChoice, PLATFORM_MESSAGES } from "@/lib/qc/platform-choice";

/** Test A of the Phase 5 brief: platform selection. */
describe("A. platform selection", () => {
  it("a valid platform and placement", () => {
    expect(parsePlatformChoice({ platform: "instagram", placement: "feed_image" }, "social_post")).toEqual({
      ok: true,
      value: {
        platform: "instagram",
        placement: "feed_image",
        customLabel: null,
        customWidth: null,
        customHeight: null,
        customUnit: null,
        customMinDpi: null,
        customMaxBytes: null,
      },
    });
  });

  it("invalid platforms and placements are refused", () => {
    expect(parsePlatformChoice({ platform: "tiktok" }, "social_post")).toEqual({ ok: false, error: PLATFORM_MESSAGES.platform });
    expect(parsePlatformChoice({ platform: "" }, "social_post")).toEqual({ ok: false, error: PLATFORM_MESSAGES.platform });
    expect(parsePlatformChoice({ platform: "instagram", placement: "billboard" }, "social_post")).toEqual({
      ok: false,
      error: PLATFORM_MESSAGES.placement,
    });
    // A video placement for an image check, and a video-only platform for images.
    expect(parsePlatformChoice({ platform: "instagram", placement: "reels" }, "social_post")).toMatchObject({ ok: false });
    expect(parsePlatformChoice({ platform: "youtube", placement: "video" }, "design_poster")).toEqual({
      ok: false,
      error: PLATFORM_MESSAGES.platformMedia,
    });
    expect(parsePlatformChoice({ platform: "print", width: "210", height: "297" }, "reel_short")).toMatchObject({ ok: false });
  });

  it("Other needs a description and a size; the unit and optional limits are checked", () => {
    expect(parsePlatformChoice({ platform: "other", width: "1920", height: "1080", unit: "px" }, "social_post")).toEqual({
      ok: false,
      error: PLATFORM_MESSAGES.label,
    });
    expect(
      parsePlatformChoice(
        { platform: "other", label: "  Airport   screen ", width: "1920", height: "1080", unit: "px", maxMb: "2.5" },
        "social_post"
      )
    ).toMatchObject({
      ok: true,
      value: { platform: "other", placement: null, customLabel: "Airport screen", customWidth: 1920, customHeight: 1080, customUnit: "px", customMaxBytes: 2_500_000 },
    });
    expect(
      parsePlatformChoice({ platform: "other", label: "Flyer", width: "148", height: "210", unit: "mm", minDpi: "300" }, "design_poster")
    ).toMatchObject({ ok: true, value: { customUnit: "mm", customMinDpi: 300 } });
    expect(parsePlatformChoice({ platform: "other", label: "Screen", width: "1920", height: "1080" }, "reel_short")).toEqual({
      ok: false,
      error: PLATFORM_MESSAGES.unit,
    });
  });

  it("custom platforms: whole-number sizes, implied unit, DPI only for print sizes", () => {
    expect(parsePlatformChoice({ platform: "website_banner", width: "1200.5", height: "628" }, "social_post")).toEqual({
      ok: false,
      error: PLATFORM_MESSAGES.size,
    });
    expect(parsePlatformChoice({ platform: "website_banner", width: "0", height: "628" }, "social_post")).toMatchObject({ ok: false });
    expect(parsePlatformChoice({ platform: "website_banner", width: "1200", height: "628" }, "social_post")).toMatchObject({
      ok: true,
      value: { customUnit: "px", customLabel: null },
    });
    // A pixel unit can't be forced onto print.
    expect(parsePlatformChoice({ platform: "print", width: "210", height: "297", unit: "px" }, "design_poster")).toMatchObject({ ok: false });
    expect(parsePlatformChoice({ platform: "print", width: "210", height: "297", minDpi: "9999" }, "design_poster")).toEqual({
      ok: false,
      error: PLATFORM_MESSAGES.dpi,
    });
    expect(parsePlatformChoice({ platform: "other", label: "x", width: "10", height: "10", unit: "px", minDpi: "300" }, "social_post")).toMatchObject({
      ok: true,
      value: { customMinDpi: null },
    });
    expect(parsePlatformChoice({ platform: "email_banner", width: "600", height: "200", maxMb: "51" }, "social_post")).toEqual({
      ok: false,
      error: PLATFORM_MESSAGES.maxBytes,
    });
  });
});
