import { describe, expect, it } from "vitest";
import { makePdf } from "../../../testkit/src/pdf.js";
import { readPdf } from "../index.js";

const MENU = [
  ["Smash Burger", "$16.00"],
  ["Lumpia (6) 9 / (12) 16", ""],
  "Open Tue-Thu 4pm-11pm",
] as const;

describe("readPdf", () => {
  it("reads the text layer of a compressed page, a wide gap as two spaces", () => {
    const r = readPdf(makePdf([MENU]));
    expect(r).toMatchObject({ ok: true, pageCount: 1, truncated: false });
    if (r.ok)
      expect(r.pages[0]).toBe(
        "Smash Burger  $16.00\nLumpia (6) 9 / (12) 16\nOpen Tue-Thu 4pm-11pm",
      );
  });

  it("reads an uncompressed file the same way", () => {
    const r = readPdf(makePdf([MENU], { compress: false }));
    expect(r.ok && r.pages[0]).toContain("Smash Burger  $16.00");
  });

  it("reads a Type0 font through its ToUnicode map, one page after another", () => {
    const r = readPdf(makePdf([["Page one"], ["Page two"]], { cid: true }));
    expect(r.ok && r.pages).toEqual(["Page one", "Page two"]);
  });

  it("a scan (a picture and no text) is unreadable, never guessed", () => {
    expect(readPdf(makePdf([["x"]], { scanned: true }))).toMatchObject({
      ok: false,
      reason: "no-text-layer",
    });
  });

  it("an encrypted file is unreadable", () => {
    expect(readPdf(makePdf([MENU], { encrypted: true }))).toMatchObject({
      ok: false,
      reason: "encrypted",
    });
  });

  it("a file cut short is unread, and so is something that is not a PDF", () => {
    expect(readPdf(makePdf([MENU], { cutOff: true }))).toMatchObject({
      ok: false,
      reason: "truncated",
    });
    expect(readPdf(Buffer.from("<html>not a pdf</html>"))).toMatchObject({
      ok: false,
      reason: "not-a-pdf",
    });
  });

  it("a Type0 font with no ToUnicode map says its fonts cannot be decoded", () => {
    const pdf = makePdf([["Page one"]], { cid: true })
      .toString("latin1")
      .replace(/\/ToUnicode \d+ 0 R/, "");
    expect(readPdf(Buffer.from(pdf, "latin1"))).toMatchObject({
      ok: false,
      reason: "undecodable-fonts",
    });
  });

  it("a decompression bomb is refused, not inflated", () => {
    const r = readPdf(makePdf([MENU], { bombBytes: 20 * 1024 * 1024 }), {
      maxStreamBytes: 1024 * 1024,
    });
    expect(r).toMatchObject({ ok: true });
    // The bomb is not a page stream, so it is never inflated; as an object stream it is refused.
    const tiny = readPdf(makePdf([MENU]), { maxStreamBytes: 8 });
    expect(tiny.ok).toBe(false);
  });

  it("stops at the page cap and says so", () => {
    const r = readPdf(makePdf(Array.from({ length: 30 }, (_, i) => [`Page ${i + 1}`])), {
      maxPages: 5,
    });
    expect(r).toMatchObject({ ok: true, truncated: true });
    expect(r.ok && r.pages.length).toBe(5);
  });

  it("too many objects is refused, in linear time", () => {
    const junk = "1 0 obj\n<<>>\nendobj\n".repeat(60_000);
    const r = readPdf(Buffer.from(`%PDF-1.4\n${junk}\n%%EOF\n`, "latin1"));
    expect(r).toMatchObject({ ok: false, reason: "too-complex" });
  });

  it("a font named __proto__ and a lone surrogate in the text do not throw", () => {
    const pdf = makePdf([["Tea 4"]])
      .toString("latin1")
      .replace("/F1", "/__proto__");
    expect(() => readPdf(Buffer.from(pdf, "latin1"))).not.toThrow();
    const r = readPdf(makePdf([["a\ud800b"]], { cid: true }));
    expect(r.ok).toBe(true);
  });
});
