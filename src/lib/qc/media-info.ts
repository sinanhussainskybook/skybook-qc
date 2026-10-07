import type { FileFormat } from "@/lib/qc/qc-file";

/**
 * Reads the technical facts of uploaded content straight from its bytes
 * (Phase 5, 5.11 / 5.14) — no AI, no OCR, no external tools:
 *
 *   images (PNG, JPEG, WEBP) — width × height as displayed (EXIF rotation
 *                              applied) and DPI when the file records it
 *   PDF                      — first page size in points (1/72 inch), page count
 *   MP4 / MOV                — width × height as displayed (rotation applied), length
 *   WEBM                     — width × height, length when recorded
 *
 * Anything that can't be read reliably is left out with a `note`, so the
 * checks report it as NOT VERIFIED instead of guessing.
 */

export type MediaInfo = {
  width?: number;
  height?: number;
  /** For PDFs: width and height are in POINTS (1/72 inch), not pixels. */
  unit: "px" | "pt";
  durationMs?: number;
  dpi?: number;
  pages?: number;
  note?: string;
};

class Reader {
  constructor(readonly b: Uint8Array) {}
  has(offset: number, length: number) {
    return offset >= 0 && offset + length <= this.b.length;
  }
  u8(o: number) {
    if (!this.has(o, 1)) throw new RangeError("out of bounds");
    return this.b[o];
  }
  u16be(o: number) {
    return (this.u8(o) << 8) | this.u8(o + 1);
  }
  u16le(o: number) {
    return this.u8(o) | (this.u8(o + 1) << 8);
  }
  u24le(o: number) {
    return this.u8(o) | (this.u8(o + 1) << 8) | (this.u8(o + 2) << 16);
  }
  u32be(o: number) {
    return ((this.u8(o) << 24) >>> 0) + ((this.u8(o + 1) << 16) | (this.u8(o + 2) << 8) | this.u8(o + 3));
  }
  i32be(o: number) {
    return this.u32be(o) | 0;
  }
  u64be(o: number) {
    return this.u32be(o) * 2 ** 32 + this.u32be(o + 4);
  }
  ascii(o: number, n: number) {
    if (!this.has(o, n)) return "";
    return String.fromCharCode(...this.b.subarray(o, o + n));
  }
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

function png(r: Reader): MediaInfo {
  const info: MediaInfo = { unit: "px", width: r.u32be(16), height: r.u32be(20) };
  // Walk chunks for pHYs (physical pixel density) until the image data starts.
  for (let o = 8; r.has(o, 8); ) {
    const length = r.u32be(o);
    const type = r.ascii(o + 4, 4);
    if (type === "pHYs" && r.has(o + 8, 9) && r.u8(o + 16) === 1) {
      info.dpi = Math.round(r.u32be(o + 8) * 0.0254); // pixels per metre → per inch
    }
    if (type === "IDAT" || type === "IEND") break;
    o += 12 + length;
  }
  return info;
}

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function exifOrientation(r: Reader, start: number): number | null {
  // start → "Exif\0\0" then a TIFF header
  if (r.ascii(start, 6) !== "Exif\u0000\u0000") return null;
  const t = start + 6;
  const little = r.ascii(t, 2) === "II";
  const u16 = (o: number) => (little ? r.u16le(o) : r.u16be(o));
  const u32 = (o: number) => (little ? r.u16le(o) + r.u16le(o + 2) * 65536 : r.u32be(o));
  const ifd = t + u32(t + 4);
  const entries = u16(ifd);
  for (let i = 0; i < entries; i++) {
    const e = ifd + 2 + i * 12;
    if (u16(e) === 0x0112) return u16(e + 8);
  }
  return null;
}

function jpeg(r: Reader): MediaInfo {
  const info: MediaInfo = { unit: "px" };
  let orientation: number | null = null;
  let o = 2;
  while (r.has(o, 4)) {
    if (r.u8(o) !== 0xff) {
      o++;
      continue;
    }
    const marker = r.u8(o + 1);
    if (marker === 0xff) {
      o++; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      o += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // end / start of scan
    const length = r.u16be(o + 2);
    const data = o + 4;
    if (marker === 0xe0 && r.ascii(data, 5) === "JFIF\u0000") {
      const units = r.u8(data + 7);
      const density = r.u16be(data + 8);
      if (density > 1 && units === 1) info.dpi = density;
      if (density > 1 && units === 2) info.dpi = Math.round(density * 2.54);
    } else if (marker === 0xe1) {
      orientation = exifOrientation(r, data) ?? orientation;
    } else if (SOF_MARKERS.has(marker)) {
      info.height = r.u16be(data + 1);
      info.width = r.u16be(data + 3);
    }
    o += 2 + length;
  }
  if (info.width && info.height && orientation && orientation >= 5 && orientation <= 8) {
    [info.width, info.height] = [info.height, info.width]; // stored sideways, shown upright
  }
  if (!info.width) info.note = "The image size couldn't be read from this JPEG.";
  return info;
}

function webp(r: Reader): MediaInfo {
  const chunk = r.ascii(12, 4);
  if (chunk === "VP8X") return { unit: "px", width: r.u24le(24) + 1, height: r.u24le(27) + 1 };
  if (chunk === "VP8 ") return { unit: "px", width: r.u16le(26) & 0x3fff, height: r.u16le(28) & 0x3fff };
  if (chunk === "VP8L") {
    const [b0, b1, b2, b3] = [r.u8(21), r.u8(22), r.u8(23), r.u8(24)];
    return {
      unit: "px",
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  return { unit: "px", note: "The image size couldn't be read from this WEBP." };
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

function pdf(bytes: Uint8Array): MediaInfo {
  let text = "";
  for (let i = 0; i < bytes.length; i += 65536) {
    text += String.fromCharCode(...bytes.subarray(i, Math.min(i + 65536, bytes.length)));
  }
  const pages = (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
  const box = /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/.exec(text);
  if (!box) {
    return {
      unit: "pt",
      pages: pages || undefined,
      note: "The page size is stored compressed in this PDF and couldn't be read.",
    };
  }
  const [x0, y0, x1, y1] = box.slice(1).map(Number);
  let width = Math.round(Math.abs(x1 - x0));
  let height = Math.round(Math.abs(y1 - y0));
  const rotate = /\/Rotate\s+(-?\d+)/.exec(text);
  if (rotate && Math.abs(Number(rotate[1])) % 180 === 90) [width, height] = [height, width];
  return { unit: "pt", width, height, pages: pages || undefined };
}

// ---------------------------------------------------------------------------
// MP4 / MOV (ISO base media file format)
// ---------------------------------------------------------------------------

type Box = { type: string; start: number; content: number; end: number };

function boxes(r: Reader, from: number, to: number): Box[] {
  const found: Box[] = [];
  for (let o = from; o + 8 <= to && r.has(o, 8); ) {
    let size = r.u32be(o);
    const type = r.ascii(o + 4, 4);
    let header = 8;
    if (size === 1) {
      size = r.u64be(o + 8);
      header = 16;
    } else if (size === 0) {
      size = to - o;
    }
    if (size < header) break;
    found.push({ type, start: o, content: o + header, end: Math.min(o + size, to) });
    o += size;
  }
  return found;
}

function isoVideo(r: Reader): MediaInfo {
  const top = boxes(r, 0, r.b.length);
  const moov = top.find((b) => b.type === "moov");
  if (!moov) return { unit: "px", note: "The video's details (moov) couldn't be found in the file." };

  const info: MediaInfo = { unit: "px" };
  const children = boxes(r, moov.content, moov.end);
  const mvhd = children.find((b) => b.type === "mvhd");
  if (mvhd) {
    const v = r.u8(mvhd.content);
    const timescale = v === 1 ? r.u32be(mvhd.content + 20) : r.u32be(mvhd.content + 12);
    const duration = v === 1 ? r.u64be(mvhd.content + 24) : r.u32be(mvhd.content + 16);
    if (timescale > 0) info.durationMs = Math.round((duration / timescale) * 1000);
  }
  for (const trak of children.filter((b) => b.type === "trak")) {
    const tkhd = boxes(r, trak.content, trak.end).find((b) => b.type === "tkhd");
    if (!tkhd) continue;
    const v = r.u8(tkhd.content);
    const matrix = tkhd.content + (v === 1 ? 52 : 40);
    const width = r.u32be(tkhd.content + (v === 1 ? 88 : 76)) / 65536;
    const height = r.u32be(tkhd.content + (v === 1 ? 92 : 80)) / 65536;
    if (width > 0 && height > 0) {
      const a = r.i32be(matrix);
      const d = r.i32be(matrix + 16);
      const rotated = a === 0 && d === 0; // 90° or 270°: shown with sides swapped
      info.width = Math.round(rotated ? height : width);
      info.height = Math.round(rotated ? width : height);
      break;
    }
  }
  if (!info.width) info.note = "The video's picture size couldn't be read.";
  return info;
}

// ---------------------------------------------------------------------------
// WEBM (EBML / Matroska)
// ---------------------------------------------------------------------------

function vint(r: Reader, o: number, keepMarker: boolean): { value: number; length: number; unknown: boolean } {
  const first = r.u8(o);
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8) throw new RangeError("bad vint");
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = (first & (0xff >> length)) === 0xff >> length;
  for (let i = 1; i < length; i++) {
    const byte = r.u8(o + i);
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

const EBML = {
  segment: 0x18538067, info: 0x1549a966, tracks: 0x1654ae6b, cluster: 0x1f43b675,
  timecodeScale: 0x2ad7b1, duration: 0x4489, trackEntry: 0xae, trackType: 0x83,
  video: 0xe0, pixelWidth: 0xb0, pixelHeight: 0xba,
};

function webm(r: Reader): MediaInfo {
  const info: MediaInfo = { unit: "px" };
  let timecodeScale = 1_000_000;
  let rawDuration: number | null = null;

  const uint = (o: number, n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + r.u8(o + i);
    return v;
  };

  const walk = (from: number, to: number, inTrack: { video: boolean; w?: number; h?: number } | null) => {
    for (let o = from; o < to && r.has(o, 2); ) {
      const id = vint(r, o, true);
      const size = vint(r, o + id.length, false);
      const data = o + id.length + size.length;
      const end = size.unknown ? to : Math.min(data + size.value, to);
      switch (id.value) {
        case EBML.cluster:
          return; // media data starts; the header elements come before it
        case EBML.segment:
        case EBML.info:
        case EBML.tracks:
          walk(data, end, null);
          break;
        case EBML.trackEntry: {
          const track = { video: false } as { video: boolean; w?: number; h?: number };
          walk(data, end, track);
          if (track.video && track.w && track.h && !info.width) {
            info.width = track.w;
            info.height = track.h;
          }
          break;
        }
        case EBML.video:
          if (inTrack) walk(data, end, inTrack);
          break;
        case EBML.trackType:
          if (inTrack) inTrack.video = uint(data, size.value) === 1;
          break;
        case EBML.pixelWidth:
          if (inTrack) inTrack.w = uint(data, size.value);
          break;
        case EBML.pixelHeight:
          if (inTrack) inTrack.h = uint(data, size.value);
          break;
        case EBML.timecodeScale:
          timecodeScale = uint(data, size.value);
          break;
        case EBML.duration: {
          const view = new DataView(r.b.buffer, r.b.byteOffset + data, size.value);
          rawDuration = size.value === 4 ? view.getFloat32(0) : view.getFloat64(0);
          break;
        }
      }
      o = end;
    }
  };

  walk(0, r.b.length, null);
  if (rawDuration !== null) info.durationMs = Math.round((rawDuration * timecodeScale) / 1_000_000);
  if (!info.width) info.note = "The video's picture size couldn't be read.";
  else if (info.durationMs === undefined) info.note = "This WEBM file doesn't record its length.";
  return info;
}

// ---------------------------------------------------------------------------

/** Measures a file already confirmed to be `format` (lib/qc/qc-file.ts). */
export function measureMedia(format: FileFormat, bytes: Uint8Array): MediaInfo {
  const r = new Reader(bytes);
  try {
    switch (format) {
      case "png":
        return png(r);
      case "jpeg":
        return jpeg(r);
      case "webp":
        return webp(r);
      case "pdf":
        return pdf(bytes);
      case "mp4":
      case "mov":
        return isoVideo(r);
      case "webm":
        return webm(r);
      default:
        return { unit: "px", note: "This kind of file isn't measured." };
    }
  } catch {
    return { unit: format === "pdf" ? "pt" : "px", note: "The file's size details couldn't be read." };
  }
}

/** Formats that are measured when uploaded as content. */
export const MEASURED_FORMATS: readonly FileFormat[] = ["png", "jpeg", "webp", "pdf", "mp4", "mov", "webm"];
