import { describe, expect, it } from "vitest";
import { sanityCdnTaggedReads } from "../sanity-cdn-tagged-reads.js";
import { fixtureTree, runOne, treeOf } from "./helpers.js";

const ID = "sanity-cdn-tagged-reads";
const run = (files: Record<string, string>, over = {}) =>
  runOne(sanityCdnTaggedReads, treeOf(files, over));

const client = (options: string, from = "next-sanity") => `import { createClient } from "${from}";
export const client = createClient({
  projectId: "harborlane",
  dataset: "production",
  ${options}
});`;
const TAGGED = {
  "app/page.tsx": `export default async function P() {
  const x = await client.fetch(q, {}, { next: { tags: ["menu"] } });
  return null;
}`,
};

describe("sanity-cdn-tagged-reads: fixtures", () => {
  it("fails the folder that reads through the CDN and caches the reads by tag", async () => {
    const out = await runOne(sanityCdnTaggedReads, await fixtureTree(ID, "fail"));
    expect(out.passed).toEqual([]);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({
      checkId: ID,
      severity: "high",
      evidence:
        "lib/sanity/client.ts:8: useCdn is true, and reads are cached by tag (app/events/page.tsx).",
      url: "source:./sanity-cdn-tagged-reads/fail",
      source: { file: "lib/sanity/client.ts", line: 8 },
    });
  });

  it("passes the folder whose client has useCdn false", async () => {
    const out = await runOne(sanityCdnTaggedReads, await fixtureTree(ID, "pass"));
    expect(out.findings).toEqual([]);
    expect(out.couldNotCheck).toEqual([]);
    expect(out.passed).toEqual([ID]);
  });
});

describe("sanity-cdn-tagged-reads: when the CDN and the tags meet", () => {
  it("passes useCdn true when nothing in the folder is cached by tag", async () => {
    const out = await run({ "lib/client.ts": client("useCdn: true,") });
    expect(out.passed).toEqual([ID]);
  });

  it.each([
    ["a next.tags option", TAGGED],
    [
      "revalidateTag",
      {
        "app/api/hook/route.ts": `import { revalidateTag } from "next/cache";
export async function POST() { revalidateTag("menu"); return new Response("ok"); }`,
      },
    ],
  ])("fails useCdn true beside %s", async (_n, tagged) => {
    const out = await run({ "lib/client.ts": client("useCdn: true,"), ...tagged });
    expect(out.passed).toEqual([]);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.source).toEqual({ file: "lib/client.ts", line: 5 });
  });

  it("reads createClient from @sanity/client as well as next-sanity", async () => {
    const out = await run({
      "lib/client.ts": client("useCdn: true,", "@sanity/client"),
      ...TAGGED,
    });
    expect(out.findings).toHaveLength(1);
  });

  it("reports each client with useCdn true, and not the one with false", async () => {
    const two = `${client("useCdn: true,")}
export const live = createClient({ projectId: "harborlane", useCdn: false });
export const search = createClient({ projectId: "harborlane", useCdn: true });`;
    const out = await run({ "lib/client.ts": two, ...TAGGED });
    expect(out.findings.map((f) => f.source?.line)).toEqual([5, 8]);
  });

  it("passes useCdn false beside tags", async () => {
    const out = await run({ "lib/client.ts": client("useCdn: false,"), ...TAGGED });
    expect(out.passed).toEqual([ID]);
  });

  it("ignores a createClient that is not Sanity's, and a useCdn inside a comment or a string", async () => {
    const out = await run({
      "lib/other.ts": client("useCdn: true,", "some-other-sdk"),
      "lib/client.ts": client(`// useCdn: true,\n  note: "useCdn: true",\n  useCdn: false,`),
      ...TAGGED,
    });
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([ID]);
  });
});

describe("sanity-cdn-tagged-reads: not sure is not a pass", () => {
  it("is unsure when useCdn is an expression", async () => {
    const out = await run({
      "lib/client.ts": client(`useCdn: process.env.NODE_ENV === "production",`),
      ...TAGGED,
    });
    expect(out.passed).toEqual([]);
    expect(out.findings).toEqual([]);
    expect(out.couldNotCheck).toEqual([
      {
        id: ID,
        reason:
          "lib/client.ts:5 sets useCdn from something other than true or false, so Gaugeline cannot tell whether it reads through the CDN.",
        url: "source:./my-site",
      },
    ]);
  });

  it("is unsure when useCdn is not set, because Gaugeline has not confirmed the default", async () => {
    const out = await run({ "lib/client.ts": client(""), ...TAGGED });
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck[0]?.reason).toBe(
      "lib/client.ts:2 does not set useCdn, and Gaugeline has not confirmed what the client does then.",
    );
  });

  it("is unsure when the options are not written in the call", async () => {
    const out = await run({
      "lib/client.ts": `import { createClient } from "next-sanity";
export const client = createClient(config);`,
      ...TAGGED,
    });
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck[0]?.reason).toContain("lib/client.ts:2");
  });

  it("is unsure, not passed, when a code file was left out and tags are in use", async () => {
    const out = await run({ ...TAGGED }, { skipped: { "lib/big.ts": "too-large" } });
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck[0]?.reason).toContain("lib/big.ts");
  });

  it("passes a folder with no Sanity client", async () => {
    const out = await run({ "app/page.tsx": "export default function P() { return null; }" });
    expect(out.passed).toEqual([ID]);
  });
});

describe("sanity-cdn-tagged-reads: what it never prints", () => {
  it("names the files and the line, never the project id, the token or a query", async () => {
    const token = ["sk", "not-a-real-value-0002"].join("");
    const out = await run({
      "lib/client.ts": client(`token: "${token}",\n  useCdn: true,`),
      "app/page.tsx": `export default async function P() {
  return client.fetch('*[_id == "drafts.secret-page"]', {}, { next: { tags: ["menu"] } });
}`,
    });
    expect(out.findings).toHaveLength(1);
    const printed = JSON.stringify(out);
    for (const leak of [token, "harborlane", "drafts.secret-page"])
      expect(printed).not.toContain(leak);
  });
});
