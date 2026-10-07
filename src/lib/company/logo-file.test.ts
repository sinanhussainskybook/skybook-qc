import { describe, expect, it } from "vitest";
import {
  checkLogoFile,
  cleanFileName,
  detectLogoKind,
  formatBytes,
  LOGO_MAX_BYTES,
  LOGO_MESSAGES,
  precheckLogoFile,
} from "@/lib/company/logo-file";
import { EXE, GIF, HTML, JPEG, PNG, SAFE_SVG, svg, WEBP } from "../../../test/logo-files";

const file = (name: string, type: string, bytes: Uint8Array, size = bytes.length) => ({
  name,
  type,
  size,
  bytes,
});

describe("logo file checks", () => {
  it("recognises PNG, JPEG, WEBP and SVG from their contents", () => {
    expect(detectLogoKind(PNG)).toBe("png");
    expect(detectLogoKind(JPEG)).toBe("jpeg");
    expect(detectLogoKind(WEBP)).toBe("webp");
    expect(detectLogoKind(SAFE_SVG)).toBe("svg");
    expect(detectLogoKind(GIF)).toBeNull();
    expect(detectLogoKind(EXE)).toBeNull();
    expect(detectLogoKind(HTML)).toBeNull();
  });

  it("accepts each supported type with a matching name and declared type", () => {
    const cases = [
      file("logo.png", "image/png", PNG),
      file("logo.JPG", "image/jpeg", JPEG),
      file("logo.jpeg", "image/jpeg", JPEG),
      file("logo.webp", "image/webp", WEBP),
      file("logo.svg", "image/svg+xml", SAFE_SVG),
      file("logo.png", "", PNG), // some browsers send no type
    ];
    for (const c of cases) {
      expect(checkLogoFile(c), c.name).toMatchObject({ ok: true });
    }
    expect(checkLogoFile(file("Acme logo.jpeg", "image/jpeg", JPEG))).toMatchObject({
      ok: true,
      value: { kind: "jpeg", mime: "image/jpeg", ext: "jpg", fileName: "Acme logo.jpeg", size: JPEG.length },
    });
  });

  it("rejects unsupported types, even when renamed", () => {
    for (const c of [
      file("logo.gif", "image/gif", GIF),
      file("logo.png", "image/png", GIF), // GIF renamed to .png
      file("logo.png", "image/png", EXE), // program renamed to .png
      file("setup.exe", "application/x-msdownload", EXE),
      file("logo.svg", "image/svg+xml", HTML), // HTML renamed to .svg
      file("page.html", "text/html", HTML),
      file("logo", "image/png", PNG), // no extension
      file("logo.pdf", "application/pdf", PNG),
    ]) {
      expect(checkLogoFile(c), `${c.name} ${c.type}`).toEqual({ ok: false, error: expect.any(String) });
    }
  });

  it("rejects a name or declared type that disagrees with the contents", () => {
    expect(checkLogoFile(file("logo.jpg", "image/jpeg", PNG))).toEqual({
      ok: false,
      error: LOGO_MESSAGES.mismatch,
    });
    expect(checkLogoFile(file("logo.png", "image/jpeg", PNG))).toEqual({
      ok: false,
      error: LOGO_MESSAGES.mismatch,
    });
    expect(checkLogoFile(file("logo.png", "text/html", PNG))).toEqual({
      ok: false,
      error: LOGO_MESSAGES.mismatch,
    });
  });

  it("rejects empty and oversized files", () => {
    expect(checkLogoFile(file("logo.png", "image/png", new Uint8Array()))).toEqual({
      ok: false,
      error: LOGO_MESSAGES.empty,
    });
    const big = new Uint8Array(LOGO_MAX_BYTES + 1);
    big.set(PNG);
    expect(checkLogoFile(file("logo.png", "image/png", big))).toEqual({
      ok: false,
      error: LOGO_MESSAGES.tooLarge,
    });
    const exact = new Uint8Array(LOGO_MAX_BYTES);
    exact.set(PNG);
    expect(checkLogoFile(file("logo.png", "image/png", exact)).ok).toBe(true);
  });

  describe("SVG safety", () => {
    it("allows a plain SVG, including in-file gradients and a public DOCTYPE", () => {
      expect(checkLogoFile(file("logo.svg", "image/svg+xml", SAFE_SVG)).ok).toBe(true);
      const withDoctype = new TextEncoder().encode(
        `<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>`
      );
      expect(checkLogoFile(file("logo.svg", "image/svg+xml", withDoctype)).ok).toBe(true);
      const embeddedPng = svg('<image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>');
      expect(checkLogoFile(file("logo.svg", "image/svg+xml", embeddedPng)).ok).toBe(true);
    });

    it("rejects SVGs that could run code, load other content or hide HTML", () => {
      const unsafe = [
        "<script>alert(1)</script>",
        "<SCRIPT >alert(1)</SCRIPT>",
        "<svg:script>alert(1)</svg:script>",
        '<rect onload="alert(1)"/>',
        '<rect ONclick = "alert(1)"/>',
        '<a href="javascript:alert(1)"><rect/></a>',
        '<a xlink:href="https://evil.example"><rect/></a>',
        '<image href="https://tracker.example/pixel.png"/>',
        '<use href="other.svg#x"/>',
        '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject>',
        '<iframe src="https://evil.example"/>',
        '<embed src="x"/>',
        '<rect style="fill:url(https://evil.example/x.svg#a)"/>',
        "<style>@import url(https://evil.example/x.css);</style>",
        '<a href="&#106;avascript:alert(1)"><rect/></a>',
        '<image href="data:text/html;base64,PHNjcmlwdD4="/>',
        '<set attributeName="onmouseover" to="alert(1)"/><rect/>',
      ];
      for (const inner of unsafe) {
        expect(checkLogoFile(file("logo.svg", "image/svg+xml", svg(inner))), inner).toEqual({
          ok: false,
          error: LOGO_MESSAGES.unsafeSvg,
        });
      }
      const entityTrick = new TextEncoder().encode(
        '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "javascript">]><svg xmlns="http://www.w3.org/2000/svg"/>'
      );
      expect(checkLogoFile(file("logo.svg", "image/svg+xml", entityTrick))).toEqual({
        ok: false,
        error: LOGO_MESSAGES.unsafeSvg,
      });
    });
  });

  it("cleans file names for display", () => {
    expect(cleanFileName("C:\\Users\\me\\Desktop\\logo.png")).toBe("logo.png");
    expect(cleanFileName("../../etc/passwd.png")).toBe("passwd.png");
    expect(cleanFileName("lo\u0000go.png")).toBe("logo.png");
    expect(cleanFileName("")).toBe("logo");
    expect([...cleanFileName(`${"a".repeat(300)}.png`)].length).toBe(255);
  });

  it("gives the browser quick checks for size and extension", () => {
    expect(precheckLogoFile({ name: "logo.png", size: 1000 })).toBeNull();
    expect(precheckLogoFile({ name: "logo.png", size: LOGO_MAX_BYTES + 1 })).toBe(LOGO_MESSAGES.tooLarge);
    expect(precheckLogoFile({ name: "logo.gif", size: 1000 })).toBe(LOGO_MESSAGES.wrongType);
    expect(precheckLogoFile({ name: "logo.png", size: 0 })).toBe(LOGO_MESSAGES.empty);
  });

  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(34 * 1024)).toBe("34 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });
});
