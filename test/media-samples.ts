/**
 * Small but structurally real media files with chosen dimensions / length,
 * for the Phase 5 measurement and platform tests. Checksums are zero (the
 * measurer doesn't read them).
 */

const text = (value: string) => [...new TextEncoder().encode(value)];
const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export function pngOf(width: number, height: number, options: { dpi?: number } = {}): Uint8Array {
  const chunk = (type: string, data: number[]) => [...u32be(data.length), ...text(type), ...data, 0, 0, 0, 0];
  const phys = options.dpi
    ? chunk("pHYs", [...u32be(Math.round(options.dpi / 0.0254)), ...u32be(Math.round(options.dpi / 0.0254)), 1])
    : [];
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", [...u32be(width), ...u32be(height), 8, 6, 0, 0, 0]),
    ...phys,
    ...chunk("IDAT", [0x78, 0x9c, 0, 0]),
    ...chunk("IEND", []),
  ]);
}

export function jpegOf(width: number, height: number, options: { dpi?: number; orientation?: number } = {}): Uint8Array {
  const segment = (marker: number, data: number[]) => [0xff, marker, ...u16be(data.length + 2), ...data];
  const jfif = segment(0xe0, [...text("JFIF"), 0, 1, 1, options.dpi ? 1 : 0, ...u16be(options.dpi ?? 1), ...u16be(options.dpi ?? 1), 0, 0]);
  const exif = options.orientation
    ? segment(0xe1, [
        ...text("Exif"), 0, 0,
        ...text("MM"), 0, 42, ...u32be(8), // big-endian TIFF, first IFD at 8
        ...u16be(1), // one entry
        ...u16be(0x0112), ...u16be(3), ...u32be(1), ...u16be(options.orientation), 0, 0,
        ...u32be(0),
      ])
    : [];
  const sof = segment(0xc0, [8, ...u16be(height), ...u16be(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const sos = segment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]);
  return new Uint8Array([0xff, 0xd8, ...jfif, ...exif, ...sof, ...sos, 0x12, 0x34, 0xff, 0xd9]);
}

export function webpOf(width: number, height: number, kind: "VP8X" | "VP8 " | "VP8L" = "VP8X"): Uint8Array {
  let chunk: number[];
  if (kind === "VP8X") chunk = [...text("VP8X"), ...u32be(10).reverse(), 0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)];
  else if (kind === "VP8 ") chunk = [...text("VP8 "), 10, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height)];
  else {
    const v = (width - 1) | ((height - 1) << 14);
    chunk = [...text("VP8L"), 5, 0, 0, 0, 0x2f, v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  }
  return new Uint8Array([...text("RIFF"), ...u32be(4 + chunk.length).reverse(), ...text("WEBP"), ...chunk]);
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

export function pdfOf(widthPt: number, heightPt: number, options: { rotate?: number; pages?: number; compressed?: boolean } = {}) {
  const pages = options.pages ?? 1;
  const box = options.compressed ? "" : `/MediaBox [0 0 ${widthPt} ${heightPt}]`;
  let body = `%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count ${pages} ${box} >>\nendobj\n`;
  for (let i = 0; i < pages; i++) {
    body += `${3 + i} 0 obj\n<< /Type /Page /Parent 2 0 R${options.rotate ? ` /Rotate ${options.rotate}` : ""} >>\nendobj\n`;
  }
  return new Uint8Array(text(`${body}%%EOF\n`));
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

const box = (type: string, content: number[]) => [...u32be(8 + content.length), ...text(type), ...content];

/**
 * An MP4 (or MOV with brand "qt  ") with one video track. `mdatBytes` pads the
 * file; with `moovAtEnd` the details come after the media data, as in many
 * camera files, so they're past the first 64 KB.
 */
export function mp4Of(
  width: number,
  height: number,
  durationMs: number,
  options: { rotated?: boolean; moovAtEnd?: boolean; mdatBytes?: number; brand?: "isom" | "qt  " } = {}
): Uint8Array {
  const brand = options.brand ?? "isom";
  const ftyp = box("ftyp", [...text(brand), 0, 0, 2, 0, ...text(brand), ...text(brand === "isom" ? "iso2" : "qt  ")]);
  const timescale = 1000;
  const mvhd = box("mvhd", [0, 0, 0, 0, ...u32be(0), ...u32be(0), ...u32be(timescale), ...u32be(durationMs), ...new Array(80).fill(0)]);
  const one = 0x00010000;
  const matrix = options.rotated
    ? [...u32be(0), ...u32be(one), ...u32be(0), ...u32be(-one >>> 0), ...u32be(0), ...u32be(0), ...u32be(0), ...u32be(0), ...u32be(0x40000000)]
    : [...u32be(one), ...u32be(0), ...u32be(0), ...u32be(0), ...u32be(one), ...u32be(0), ...u32be(0), ...u32be(0), ...u32be(0x40000000)];
  const tkhd = box("tkhd", [
    0, 0, 0, 3, ...u32be(0), ...u32be(0), ...u32be(1), ...u32be(0), ...u32be(durationMs),
    ...new Array(8).fill(0), 0, 0, 0, 0, 0, 0, 0, 0,
    ...matrix, ...u32be(width * 65536), ...u32be(height * 65536),
  ]);
  const moov = box("moov", [...mvhd, ...box("trak", tkhd)]);
  const mdat = box("mdat", new Array(options.mdatBytes ?? 16).fill(0));
  return new Uint8Array(options.moovAtEnd ? [...ftyp, ...mdat, ...moov] : [...ftyp, ...moov, ...mdat]);
}

const ebmlSize = (n: number) => (n < 127 ? [0x80 | n] : [0x40 | (n >> 8), n & 0xff]);
const el = (id: number[], content: number[]) => [...id, ...ebmlSize(content.length), ...content];

export function webmOf(width: number, height: number, durationMs: number): Uint8Array {
  const header = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], text("webm")));
  const duration = new Uint8Array(8);
  new DataView(duration.buffer).setFloat64(0, durationMs);
  const info = el([0x15, 0x49, 0xa9, 0x66], [
    ...el([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]), // TimecodeScale 1,000,000 ns → ms
    ...el([0x44, 0x89], [...duration]),
  ]);
  const video = el([0xe0], [...el([0xb0], u16be(width)), ...el([0xba], u16be(height))]);
  const tracks = el([0x16, 0x54, 0xae, 0x6b], el([0xae], [...el([0x83], [1]), ...video]));
  const cluster = el([0x1f, 0x43, 0xb6, 0x75], [0xe7, 0x81, 0x00]);
  // Segment with "unknown" size, as live-recorded files have.
  const segment = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...info, ...tracks, ...cluster];
  return new Uint8Array([...header, ...segment]);
}

/**
 * A well-formed multi-page PDF (page tree, content streams, xref) that a real
 * renderer can draw: each page has a black bar near the top. `pdfOf` above is
 * only for byte-level measurement tests.
 */
export function renderablePdf(pages: number, widthPt = 595, heightPt = 842): Uint8Array {
  const objects: string[] = [];
  const pageIds = Array.from({ length: pages }, (_, i) => 3 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`;
  for (const [i, id] of pageIds.entries()) {
    const stream = `0 0 0 rg 60 ${heightPt - 120 - i} ${widthPt - 120} 40 re f`;
    objects[id] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] /Contents ${id + 1} 0 R >>`;
    objects[id + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  let body = "%PDF-1.7\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(new TextEncoder().encode(body));
}
