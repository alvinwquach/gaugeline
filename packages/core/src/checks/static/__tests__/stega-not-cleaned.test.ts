import { describe, expect, it } from "vitest";
import { parseResult } from "../../../result.js";
import { fixtureTree, registered, runOne, spots, treeOf } from "./tokens-forms-helpers.js";

const ID = "stega-not-cleaned";
const LIVE =
  'import { defineLive } from "next-sanity";\nexport const { sanityFetch } = defineLive({ client });\n';
const page = (body: string) =>
  `import { sanityFetch } from "./live";\nexport default async function P() {\n  const { data } = await sanityFetch({ query: "q" });\n${body}\n}\n`;
const run = (body: string, files: Record<string, string> = { "live.ts": LIVE }) =>
  runOne(ID, treeOf({ "page.tsx": page(body), ...files }));

describe(ID, () => {
  it("is in the static pack", () => expect(registered(ID)).toBe(true));

  describe("the two fixtures", () => {
    it("fails the page that compares and links uncleaned text", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "fail"));
      expect(spots(result)).toEqual(["app/page.tsx:6", "app/page.tsx:7"]);
      expect(result.findings.map((f) => f.evidence)).toEqual([
        "app/page.tsx: stega is on, and a fetched value is compared with a string without stegaClean.",
        "app/page.tsx: stega is on, and a link or attribute is built from a fetched value without stegaClean.",
      ]);
      expect(parseResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
    });

    it("passes the page that cleans both", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "pass"));
      expect(result.findings).toEqual([]);
      expect(result.passed).toEqual([ID]);
    });
  });

  describe("what it finds", () => {
    const cases: [string, string, string][] = [
      ["a comparison", '  return data.theme === "dark";', "compared with a string"],
      ["an inequality", "  return data.theme !== 'dark';", "compared with a string"],
      ["an href", "  return <a href={data.url}>x</a>;", "a link or attribute"],
      ["a template href", "  return <a href={`/menu/${data.slug}`}>x</a>;", "a link or attribute"],
      ["an id", "  return <div id={data.anchor} />;", "a link or attribute"],
      [
        "metadata",
        "}\nexport async function generateMetadata() {\n  const { data } = await sanityFetch({ query: 'q' });\n  return { title: data.title };",
        "page metadata",
      ],
    ];
    it.each(cases)("%s", async (_name, body, what) => {
      const result = await run(body);
      expect(result.findings.length, body).toBeGreaterThan(0);
      expect(result.findings[0]?.evidence).toContain(what);
    });

    it("the setup in any of its forms", async () => {
      for (const setup of [
        "export const c = createClient({ stega: true });",
        "export const c = createClient({ stega: { enabled: true, studioUrl: '/studio' } });",
        "export const v = <VisualEditing />;",
      ]) {
        const result = await run('  return data.theme === "dark";', { "live.ts": setup });
        expect(result.findings.length, setup).toBeGreaterThan(0);
      }
    });
  });

  describe("what it leaves alone", () => {
    const quiet: [string, string][] = [
      ["a cleaned comparison", '  return stegaClean(data.theme) === "dark";'],
      ["a comparison of an underscore field", '  return data._type === "page";'],
      ["a comparison of the environment", '  return process.env.NODE_ENV === "production";'],
      ["a request method", '  return request.method === "POST";'],
      ["a plain constant href", '  return <a href="/menu">x</a>;'],
      ["visible text", "  return <h1>{data.title}</h1>;"],
      ["a comment", '  // return data.theme === "dark";\n  return null;'],
    ];
    it.each(quiet)("%s", async (_name, body) => {
      const result = await run(body);
      expect(result.findings, body).toEqual([]);
      expect(result.passed, body).toEqual([ID]);
    });
    it("a file that mentions stegaClean anywhere", async () => {
      const result = await run(
        '  const clean = stegaClean;\n  return data.theme === "dark" && clean;',
      );
      expect(result.passed).toEqual([ID]);
    });
    it("a folder with no stega setup: nothing is encoded", async () => {
      const result = await run('  return data.theme === "dark";', {
        "live.ts": "export const x = 1;",
      });
      expect(result.passed).toEqual([ID]);
    });
    it("a file that fetches nothing", async () => {
      const result = await runOne(
        ID,
        treeOf({
          "live.ts": LIVE,
          "card.tsx": 'export const C = (p: { theme: string }) => p.theme === "dark";',
        }),
      );
      expect(result.passed).toEqual([ID]);
    });
  });

  describe("not sure is not a pass", () => {
    it("no source is could-not-check", async () => {
      const result = await runOne(ID, treeOf({}));
      expect(result.passed).toEqual([]);
      expect(result.couldNotCheck.map((c) => c.id)).toEqual([ID]);
    });
    it("a source file left out", async () => {
      const result = await runOne(
        ID,
        treeOf({ "a.ts": "export {};" }, { skipped: new Map([["b.ts", "unreadable"]]) }),
      );
      expect(result.passed).toEqual([]);
    });
  });
});
