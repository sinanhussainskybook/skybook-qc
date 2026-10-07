/** Small byte samples for logo tests (the checks only read the start of a file). */

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);

export const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52);
export const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0);
export const WEBP = new Uint8Array([...text("RIFF"), 36, 0, 0, 0, ...text("WEBPVP8 "), 0, 0, 0, 0]);
export const GIF = text("GIF89a\u0001\u0000\u0001\u0000");
export const EXE = bytes(0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00);
export const HTML = text("<!doctype html><html><body><script>alert(1)</script></body></html>");

export const SAFE_SVG = text(
  `<?xml version="1.0" encoding="UTF-8"?>
<!-- exported logo -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">
  <defs><linearGradient id="g"><stop offset="0" stop-color="#1A64B4"/></linearGradient></defs>
  <rect width="10" height="10" fill="url(#g)"/><use xlink:href="#g"/>
</svg>`
);

// Phase 4 formats
export const PDF = text("%PDF-1.7\n%âãÏÓ\n1 0 obj\n<< /Type /Catalog >>\nendobj\n");
const zipWith = (...entries: string[]) =>
  new Uint8Array([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, ...entries.flatMap((e) => [...text(e), 0, 0, 0, 0])]);
export const DOCX = zipWith("[Content_Types].xml", "_rels/.rels", "word/document.xml");
export const XLSX = zipWith("[Content_Types].xml", "_rels/.rels", "xl/workbook.xml");
export const DOCM = zipWith("[Content_Types].xml", "word/document.xml", "word/vbaProject.bin");
export const PLAIN_ZIP = zipWith("photos/a.jpg");
export const OLE = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0);
export const TXT = text("Client brief\nOffer: 20% off\nCall +971 4 123 4567\n");
export const MP4 = new Uint8Array([0, 0, 0, 24, ...text("ftypisom"), 0, 0, 2, 0, ...text("isomiso2")]);
export const MOV = new Uint8Array([0, 0, 0, 20, ...text("ftypqt  "), 0, 0, 2, 0, ...text("qt  ")]);
export const OLD_MOV = new Uint8Array([0, 0, 0, 8, ...text("wide"), 0, 0, 0, 8, ...text("mdat")]);
export const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, ...text("B\u0082\u0084webm")]);
export const MKV = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, ...text("B\u0082\u0088matroska")]);

export const svg = (inner: string) =>
  text(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${inner}</svg>`);
