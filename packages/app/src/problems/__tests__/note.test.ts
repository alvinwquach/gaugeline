import { describe, expect, it } from "vitest";
import { CHECK_TEXT } from "../../check-titles";
import { finding } from "../../__tests__/helpers";
import { buildNote } from "../note";

const run = { url: "https://shop.example/" };
const high = finding({
  checkId: "canonical-elsewhere",
  severity: "high",
  title: "This page tells Google to show a different page",
  url: "https://shop.example/menu",
  evidence: "canonical points to https://shop.example/other",
});

// A high finding whose catalogue text has no angle brackets in it, for the tests about markup.
const plain = finding({
  checkId: "broken-links",
  severity: "high",
  title: "Links on this page go nowhere",
  url: "https://shop.example/menu",
  evidence: "https://shop.example/gone returned 404",
});

describe("buildNote", () => {
  it("is the same string for the same input", () => {
    expect(buildNote(high, run)).toBe(buildNote({ ...high }, { ...run }));
  });

  it("has the title, the address, why, fix, the technical line, the evidence and the check id, in that order", () => {
    const [, why, fix, tech] = CHECK_TEXT["canonical-elsewhere"] as readonly string[];
    expect(buildNote(high, run)).toBe(
      [
        "This page tells Google to show a different page",
        "",
        "Page: https://shop.example/menu",
        "",
        "Why it matters:",
        why,
        "",
        "How to fix it:",
        fix,
        "",
        "Technical detail:",
        tech,
        "",
        "Evidence:",
        "canonical points to https://shop.example/other",
        "",
        "Check: canonical-elsewhere",
      ].join("\n"),
    );
  });

  it("contains the title, the address, the evidence and the check id, and no HTML tags", () => {
    const note = buildNote(plain, run);
    expect(note).toContain(plain.title);
    expect(note).toContain(plain.url);
    expect(note).toContain(plain.evidence);
    expect(note).toContain(plain.checkId);
    expect(note).not.toMatch(/<\/?[a-z][^>]*>/i);
    // Plain text: no Markdown headings, bold or fences either.
    expect(note).not.toMatch(/^#|\*\*|```/m);
  });

  it("adds no markup of its own: the only tags are in words the catalogue wrote about tags", () => {
    const tech = (CHECK_TEXT["canonical-elsewhere"] as readonly string[])[3] as string;
    expect(tech).toMatch(/<link/);
    expect(buildNote(high, run).replace(tech, "")).not.toMatch(/<\/?[a-z][^>]*>/i);
  });

  it("puts the sections in the order the entry gives", () => {
    const note = buildNote(high, run);
    const at = [
      high.title,
      "Page:",
      "Why it matters:",
      "How to fix it:",
      "Technical detail:",
      "Evidence:",
      "Check:",
    ].map((s) => note.indexOf(s));
    expect(at.every((n) => n >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("leaves the evidence section out when there is none: no undefined, no empty heading", () => {
    for (const evidence of ["", "   \n "]) {
      const note = buildNote(finding({ ...high, evidence }), run);
      expect(note).not.toContain("Evidence");
      expect(note).not.toContain("undefined");
      expect(note).not.toMatch(/:\n\n/);
      expect(note.endsWith("Check: canonical-elsewhere")).toBe(true);
    }
  });

  it("carries a 5,000-character address in the evidence whole", () => {
    const long = `https://shop.example/${"a".repeat(5000)}`;
    const note = buildNote(finding({ ...high, evidence: `404: ${long}` }), run);
    expect(note).toContain(long);
    expect(note.split(long).length).toBe(2);
  });

  it("falls back to the run's address when the finding has none", () => {
    expect(buildNote(finding({ ...high, url: "" }), run)).toContain("Page: https://shop.example/");
  });

  it("for a check this build has no text for, leaves out why, fix and technical detail", () => {
    const note = buildNote(finding({ checkId: "from-a-newer-version", title: "Newer" }), run);
    expect(note).not.toContain("Why it matters");
    expect(note).not.toContain("How to fix it");
    expect(note).not.toContain("Technical detail");
    expect(note).toContain("Newer");
    expect(note).toContain("Check: from-a-newer-version");
  });

  it("uses line feeds only, whatever the page sent", () => {
    const note = buildNote(finding({ ...high, evidence: "one\r\ntwo\rthree" }), run);
    expect(note).not.toContain("\r");
    expect(note).toContain("one\ntwo\nthree");
  });

  it("keeps the page's own words as they are: markup in the evidence is text, not removed", () => {
    const evidence = "<img src=x onerror=alert(1)> returned 404";
    expect(buildNote(finding({ ...high, evidence }), run)).toContain(evidence);
  });

  it("matches the snapshot for a high finding", () => {
    expect(buildNote(plain, run)).toMatchSnapshot();
  });
});
