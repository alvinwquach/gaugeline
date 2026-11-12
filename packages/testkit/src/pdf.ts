import { deflateSync } from "node:zlib";

/**
 * Invented PDFs for tests, built in code (no file in the repository is a real client's). A line is
 * a string, or a [left, right] pair placed far apart on the same line, like a menu's name and price.
 */
export type PdfLine = string | readonly [left: string, right: string];

export interface PdfOptions {
  /** Deflate the content streams (default true). */
  compress?: boolean;
  /** Use a Type0 font with an Identity-H encoding and a ToUnicode map, like a word processor. */
  cid?: boolean;
  /** Pages with a picture and no text. */
  scanned?: boolean;
  /** Add an /Encrypt entry to the trailer. */
  encrypted?: boolean;
  /** Leave off the end-of-file marker, as a download cut short would. */
  cutOff?: boolean;
  /** Put this much of a repeated zero byte (deflated) in an extra stream: a decompression bomb. */
  bombBytes?: number;
}

function esc(text: string): string {
  return text.replace(/[\\()]/g, (c) => `\\${c}`);
}

/** Glyph ids are char codes shifted by 29, so the ToUnicode map has to be read to get the letters back. */
const SHIFT = 29;

function cidHex(text: string): string {
  let out = "";
  for (const ch of text) out += (ch.codePointAt(0)! + SHIFT).toString(16).padStart(4, "0");
  return out;
}

export function makePdf(pages: readonly (readonly PdfLine[])[], options: PdfOptions = {}): Buffer {
  const compress = options.compress ?? true;
  const objects: Buffer[] = [];
  const add = (body: string | Buffer): number => {
    objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1"));
    return objects.length;
  };
  const stream = (dict: string, data: Buffer, deflate: boolean): number => {
    const body = deflate ? deflateSync(data) : data;
    return add(
      Buffer.concat([
        Buffer.from(
          `<< ${dict}${deflate ? " /Filter /FlateDecode" : ""} /Length ${body.length} >>\nstream\n`,
          "latin1",
        ),
        body,
        Buffer.from("\nendstream", "latin1"),
      ]),
    );
  };
  // 1: catalogue, 2: page tree (filled in at the end), 3: font, 4: ToUnicode (cid only)
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("");
  let fontRef = 0;
  if (options.cid) {
    const cmap =
      "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n1 begincodespacerange <0000> <FFFF> endcodespacerange\n" +
      `1 beginbfrange <${(32 + SHIFT).toString(16).padStart(4, "0")}> <${(126 + SHIFT).toString(16).padStart(4, "0")}> <0020> endbfrange\n` +
      "endcmap end end";
    const cmapRef = stream("", Buffer.from(cmap, "latin1"), compress);
    const descendant = add(
      "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /InventedSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>",
    );
    fontRef = add(
      `<< /Type /Font /Subtype /Type0 /BaseFont /InventedSans /Encoding /Identity-H /DescendantFonts [${descendant} 0 R] /ToUnicode ${cmapRef} 0 R >>`,
    );
  } else {
    fontRef = add(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    );
  }
  const imageRef = options.scanned
    ? stream(
        "/Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceGray /BitsPerComponent 8",
        Buffer.alloc(16, 200),
        false,
      )
    : 0;
  const kids: number[] = [];
  const pageIds: number[] = [];
  for (const lines of pages) {
    let content = "";
    if (options.scanned) content = "q 400 0 0 400 50 200 cm /Im1 Do Q";
    else {
      let y = 740;
      const show = (text: string, x: number): string =>
        options.cid
          ? `BT /F1 12 Tf 1 0 0 1 ${x} ${y} Tm <${cidHex(text)}> Tj ET\n`
          : `BT /F1 12 Tf 1 0 0 1 ${x} ${y} Tm (${esc(Buffer.from(text, "latin1").toString("latin1"))}) Tj ET\n`;
      for (const line of lines) {
        if (typeof line === "string") content += show(line, 50);
        else content += show(line[0], 50) + show(line[1], 420);
        y -= 18;
      }
    }
    const contentRef = stream("", Buffer.from(content, "latin1"), compress);
    const resources = `<< /Font << /F1 ${fontRef} 0 R >>${imageRef ? ` /XObject << /Im1 ${imageRef} 0 R >>` : ""} >>`;
    pageIds.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${resources} /Contents ${contentRef} 0 R >>`,
      ),
    );
    kids.push(pageIds.at(-1)!);
  }
  if (options.bombBytes) stream("", Buffer.alloc(options.bombBytes), true);
  objects[1] = Buffer.from(
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`,
    "latin1",
  );

  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets: number[] = [];
  let at = parts[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(at);
    const piece = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, "latin1"),
      body,
      Buffer.from("\nendobj\n", "latin1"),
    ]);
    parts.push(piece);
    at += piece.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${options.encrypted ? " /Encrypt 99 0 R" : ""} >>\nstartxref\n${at}\n${options.cutOff ? "" : "%%EOF\n"}`;
  parts.push(Buffer.from(xref + trailer, "latin1"));
  return Buffer.concat(parts);
}
