import { unzipSync, strFromU8 } from "fflate";

/**
 * Reading text from uploaded information files (6.7), locally. Office files
 * are ZIP archives of XML: only the text parts are read, with size limits, and
 * nothing in them is run (macros were already refused at upload, Phase 4).
 */

/** Unzipped parts beyond this size are refused (zip bombs). */
const MAX_UNZIPPED_BYTES = 40_000_000;

function unzipText(bytes: Uint8Array, wanted: (name: string) => boolean): Record<string, string> | null {
  let total = 0;
  try {
    const files = unzipSync(bytes, {
      filter: (file) => {
        if (!wanted(file.name)) return false;
        total += file.originalSize;
        return total <= MAX_UNZIPPED_BYTES;
      },
    });
    if (total > MAX_UNZIPPED_BYTES) return null;
    return Object.fromEntries(Object.entries(files).map(([name, data]) => [name, strFromU8(data)]));
  } catch {
    return null;
  }
}

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

export function docxText(bytes: Uint8Array): string | null {
  const parts = unzipText(bytes, (n) => n === "word/document.xml");
  const xml = parts?.["word/document.xml"];
  if (xml === undefined) return null;
  return decodeXml(
    xml
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<w:br[^>]*\/>/g, "\n")
      .replace(/<[^>]+>/g, "")
  ).trim();
}

export function xlsxText(bytes: Uint8Array): string | null {
  const parts = unzipText(bytes, (n) => n === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  if (!parts) return null;
  const shared = [...(parts["xl/sharedStrings.xml"] ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => decodeXml(m[1].replace(/<[^>]+>/g, "")));
  const sheets = Object.keys(parts)
    .filter((n) => n.startsWith("xl/worksheets/"))
    .sort();
  if (!sheets.length) return null;
  const lines: string[] = [];
  for (const sheet of sheets) {
    for (const row of parts[sheet].matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [...row[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)].map(([, attrs, inner]) => {
        const value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        if (/t="s"/.test(attrs) && value !== undefined) return shared[Number(value)] ?? "";
        if (/t="inlineStr"/.test(attrs)) return decodeXml(inner.replace(/<[^>]+>/g, ""));
        return value !== undefined ? decodeXml(value) : "";
      });
      const line = cells.filter(Boolean).join("\t");
      if (line) lines.push(line);
    }
  }
  return lines.join("\n");
}

export function plainText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/\u0000/g, "");
}
