import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isRefusal } from "../proposal.js";
import type { RepoFile } from "../redirect.js";
import { fixStructuredData, structuredDataProposals } from "../structured-data.js";

const FIX = fileURLToPath(new URL("../../../../fixtures/fix-proposals/", import.meta.url));
const layout = readFileSync(`${FIX}cedar-bar/src/layout.html`, "utf8");
const d = { property: "telephone", found: "+1 555 0100", expected: "+1 555 0142" };
const out = (files: RepoFile[], x = d) => {
  const r = fixStructuredData(files, x);
  if (isRefusal(r)) throw new Error(`expected a change, got: ${r.refused}`);
  return r;
};
const refused = (files: RepoFile[], x = d) => {
  const r = fixStructuredData(files, x);
  if (!isRefusal(r)) throw new Error("expected a refusal");
  return r.refused;
};

describe("a structured-data value that disagrees with the page: unit", () => {
  it("corrects the one value in an HTML file's JSON-LD block (the fixture)", () => {
    const r = out([{ path: "src/layout.html", text: layout }]);
    expect(r.path).toBe("src/layout.html");
    expect(r.after).toBe(layout.replace('"+1 555 0100"', '"+1 555 0142"'));
  });
  it("corrects a value in a JavaScript object, keeping its quote style", () => {
    const text =
      "export const ld = {\n  '@context': 'https://schema.org',\n  telephone: '+1 555 0100',\n};\n";
    expect(out([{ path: "src/ld.ts", text }]).after).toBe(text.replace("0100", "0142"));
  });
  it("corrects a .json file, and escapes what JSON needs escaped", () => {
    const text =
      '{"@context":"https://schema.org","@type":"Cafe","name":"Cafe Uno","telephone":"+1 555 0100"}';
    expect(out([{ path: "ld.json", text }]).after).toBe(text.replace("0100", "0142"));
    expect(
      out([{ path: "ld.json", text }], {
        ...d,
        property: "name",
        found: "Cafe Uno",
        expected: 'Cafe "Uno"',
      }).after,
    ).toContain('"name":"Cafe \\"Uno\\""');
  });
  it("is deterministic", () => {
    const files = [{ path: "src/layout.html", text: layout }];
    expect(out(files)).toEqual(out(files));
  });
});

describe("a structured-data fixer that is not certain makes no proposal", () => {
  const html = (body: string) => [{ path: "a.html", text: body }];
  it("the wrong value is nowhere, or in more than one place", () => {
    expect(
      refused(html('<script type="application/ld+json">{"telephone":"+1 555 9999"}</script>')),
    ).toMatch(/not found/);
    expect(
      refused(
        html(
          '<script type="application/ld+json">{"telephone":"+1 555 0100","x":{"telephone":"+1 555 0100"}}</script>',
        ),
      ),
    ).toMatch(/more than one/);
    expect(
      refused([
        {
          path: "a.html",
          text: '<script type="application/ld+json">{"telephone":"+1 555 0100"}</script>',
        },
        { path: "b.json", text: '{"@context":"https://schema.org","telephone":"+1 555 0100"}' },
      ]),
    ).toMatch(/more than one/);
  });
  it("the same text is also visible copy in the file, so the file is not the only source", () => {
    expect(
      refused(
        html(
          '<p>+1 555 0100</p><script type="application/ld+json">{"telephone":"+1 555 0100"}</script>',
        ),
      ),
    ).toMatch(/more than one/);
  });
  it("the value is not the whole value of a JSON-LD property, or the file is not JSON-LD", () => {
    expect(
      refused(
        html('<script type="application/ld+json">{"description":"call +1 555 0100 now"}</script>'),
      ),
    ).toMatch(/not found/);
    expect(refused([{ path: "a.json", text: '{"telephone":"+1 555 0100"}' }])).toMatch(/not found/);
  });
  it("the property named by the finding is not the one that holds the value", () => {
    expect(
      refused(html('<script type="application/ld+json">{"faxNumber":"+1 555 0100"}</script>')),
    ).toMatch(/not found/);
  });
  it("a replacement it cannot write exactly, or that changes nothing", () => {
    const files = html('<script type="application/ld+json">{"telephone":"+1 555 0100"}</script>');
    for (const expected of ["", "a\nb", "x".repeat(300), "+1 555 0100", "back\\slash", "${x}"])
      expect(
        isRefusal(fixStructuredData(files, { ...d, expected })),
        JSON.stringify(expected),
      ).toBe(true);
  });
});

describe("structuredDataProposals: the facts-match finding", () => {
  const files = [{ path: "src/layout.html", text: layout }];
  const finding = (evidence: string) => ({
    checkId: "facts-match",
    url: "https://cedarbar.example/",
    evidence,
  });
  it("reads the declared value and each structured-data value that differs", () => {
    const got = structuredDataProposals(
      files,
      finding('phone: declared "+1 555 0142"; /about has "+1 555 0100" (structured data)'),
      { repository: "studio/cedar-bar" },
    );
    expect(got).toHaveLength(1);
    expect(isRefusal(got[0]!)).toBe(false);
  });
  it("ignores text and link occurrences, and an evidence line it cannot read exactly", () => {
    expect(
      structuredDataProposals(files, finding('phone: declared "1"; /a has "2" (text)'), {}),
    ).toEqual([]);
    expect(structuredDataProposals(files, finding("something else"), {})).toEqual([]);
    expect(
      structuredDataProposals(
        files,
        finding('phone: declared "1"; /a has "2" (structured data) and 3 more'),
        {},
      ).length,
    ).toBe(1);
  });
});
