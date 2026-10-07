import { ANALYSIS_LIMITS } from "@/lib/analysis/limits";

/**
 * PDF pages rendered locally with MuPDF (WebAssembly, in-process): no network
 * access, PDF JavaScript switched off, encrypted files refused, and only the
 * allowed number of pages. The original upload is not changed.
 */

type Mupdf = typeof import("mupdf");
let loaded: Promise<Mupdf> | null = null;
const mupdf = () => (loaded ??= import("mupdf"));

/** Render at this resolution, capped by the long-edge limit (good for OCR). */
const RENDER_DPI = 200;

export type RenderedPage = { page: number; png: Uint8Array; width: number; height: number };

export type PdfPages = { pageCount: number; pages: RenderedPage[] } | { unsupported: string };

function open(m: Mupdf, bytes: Uint8Array) {
  const doc = m.Document.openDocument(bytes, "application/pdf");
  if (doc.needsPassword()) {
    doc.destroy();
    return null;
  }
  const pdf = doc.asPDF();
  if (pdf) pdf.disableJS();
  return doc;
}

export async function renderPdfPages(bytes: Uint8Array, maxPages: number = ANALYSIS_LIMITS.maxPagesPerFile, longEdge: number = ANALYSIS_LIMITS.ocrImageLongEdge): Promise<PdfPages> {
  const m = await mupdf();
  let doc;
  try {
    doc = open(m, bytes);
  } catch {
    return { unsupported: "the PDF couldn't be opened" };
  }
  if (!doc) return { unsupported: "the PDF is password-protected" };
  try {
    const pageCount = doc.countPages();
    const pages: RenderedPage[] = [];
    for (let i = 0; i < Math.min(pageCount, maxPages); i++) {
      const page = doc.loadPage(i);
      try {
        const [x0, y0, x1, y1] = page.getBounds();
        const longest = Math.max(x1 - x0, y1 - y0, 1);
        const scale = Math.min(RENDER_DPI / 72, longEdge / longest);
        const pixmap = page.toPixmap(m.Matrix.scale(scale, scale), m.ColorSpace.DeviceRGB, false, true);
        try {
          pages.push({ page: i + 1, png: pixmap.asPNG(), width: pixmap.getWidth(), height: pixmap.getHeight() });
        } finally {
          pixmap.destroy();
        }
      } finally {
        page.destroy();
      }
    }
    return { pageCount, pages };
  } catch {
    return { unsupported: "the PDF couldn't be rendered" };
  } finally {
    doc.destroy();
  }
}

/** The text layer of a PDF (information files, 6.7). Empty pages = probably scanned. */
export async function pdfText(bytes: Uint8Array, maxPages: number): Promise<{ pageCount: number; pages: string[] } | { unsupported: string }> {
  const m = await mupdf();
  let doc;
  try {
    doc = open(m, bytes);
  } catch {
    return { unsupported: "the PDF couldn't be opened" };
  }
  if (!doc) return { unsupported: "the PDF is password-protected" };
  try {
    const pageCount = doc.countPages();
    const pages: string[] = [];
    for (let i = 0; i < Math.min(pageCount, maxPages); i++) {
      const page = doc.loadPage(i);
      try {
        const text = page.toStructuredText("preserve-whitespace");
        pages.push(text.asText());
        text.destroy();
      } finally {
        page.destroy();
      }
    }
    return { pageCount, pages };
  } catch {
    return { unsupported: "the PDF couldn't be read" };
  } finally {
    doc.destroy();
  }
}
