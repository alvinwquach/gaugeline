import { describe, expect, it } from "vitest";
import { parseResult } from "../../../result.js";
import {
  expectNoneOf,
  fixtureTree,
  registered,
  runOne,
  spots,
  treeOf,
} from "./tokens-forms-helpers.js";

const ID = "webhook-purges-draft-ids";
const ROUTE = "app/api/revalidate/route.ts";

/** A receiver with `body` between the signature test and the end of the handler. */
const receiver = (body: string): string => `import { revalidateTag } from "next/cache";
import { parseBody } from "next-sanity/webhook";

export async function POST(req: Request) {
  const { isValidSignature, body } = await parseBody(req, process.env.SANITY_REVALIDATE_SECRET);
  if (isValidSignature !== true) return new Response("no", { status: 401 });
${body}
  return Response.json({ ok: true });
}
`;
const flagged = async (code: string, path = ROUTE) =>
  (await runOne(ID, treeOf({ [path]: code }))).findings.map((f) => f.evidence);

describe(ID, () => {
  it("is in the static pack", () => expect(registered(ID)).toBe(true));

  describe("the two fixtures", () => {
    it("fails the receiver that clears the cache by a document id with nothing about drafts", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "fail"));
      expect(spots(result)).toEqual([`${ROUTE}:15`]);
      expect(result.findings[0]).toMatchObject({
        checkId: ID,
        severity: "low",
        evidence: `${ROUTE}:15: this receiver reads the document id and clears the cache, and nothing in it skips an id that starts with drafts. or versions.`,
      });
      expect(parseResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
    });

    it("passes the receiver that returns early for drafts. and versions. ids", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "pass"));
      expect(result.findings).toEqual([]);
      expect(result.passed).toEqual([ID]);
    });
  });

  describe("what it finds", () => {
    it.each([
      ["revalidateTag by the id", "  revalidateTag(body._id);"],
      [
        "revalidatePath after reading the id",
        "  const id = body._id;\n  revalidatePath(`/${id}`);",
      ],
      ["updateTag", "  const { _id } = body;\n  updateTag(_type);"],
      [
        "a documentId from the payload",
        "  const { documentId } = body;\n  revalidateTag(documentId);",
      ],
    ])("%s", async (_n, code) => {
      expect(await flagged(receiver(code))).toHaveLength(1);
    });

    it("reports a receiver once, at its first clear", async () => {
      const out = await runOne(
        ID,
        treeOf({ [ROUTE]: receiver("  revalidateTag(body._id);\n  revalidateTag(body._type);") }),
      );
      expect(spots(out)).toEqual([`${ROUTE}:7`]);
    });
  });

  describe("what it leaves alone", () => {
    it.each([
      [
        "a startsWith on drafts.",
        '  if (body._id.startsWith("drafts.")) return Response.json({});\n  revalidateTag(body._id);',
      ],
      [
        "a startsWith on versions.",
        "  if (body._id.startsWith('versions.')) return Response.json({});\n  revalidateTag(body._id);",
      ],
      [
        "a regular expression",
        "  if (/^drafts\\./.test(body._id)) return Response.json({});\n  revalidateTag(body._id);",
      ],
      ["the id helper", "  const id = getPublishedId(body._id);\n  revalidateTag(id);"],
      [
        "isDraftId",
        "  if (isDraftId(body._id)) return Response.json({});\n  revalidateTag(body._id);",
      ],
    ])("a receiver with %s", async (_n, code) => {
      expect(await flagged(receiver(code))).toEqual([]);
    });

    it("does not count drafts. in a comment as a guard", async () => {
      const out = await flagged(receiver('  // skip "drafts." ids\n  revalidateTag(body._id);'));
      expect(out).toHaveLength(1);
    });

    it("leaves a file that never clears the cache, and a file that is not a receiver", async () => {
      const noClear = await runOne(
        ID,
        treeOf({ [ROUTE]: receiver("  console.info(body._type);") }),
      );
      expect(noClear.findings).toEqual([]);
      const other = await flagged(
        'import { revalidateTag } from "next/cache";\nexport const f = (_id: string) => revalidateTag(_id);',
        "lib/cache.ts",
      );
      expect(other).toEqual([]);
    });

    it("does not read a test file", async () => {
      expect(
        await flagged(receiver("  revalidateTag(body._id);"), "app/api/revalidate/route.test.ts"),
      ).toEqual([]);
    });
  });

  describe("not sure is not a pass", () => {
    it("a receiver that clears the cache without reading an id is could-not-check", async () => {
      const result = await runOne(ID, treeOf({ [ROUTE]: receiver('  revalidateTag("menu");') }));
      expect(result.findings).toEqual([]);
      expect(result.passed).toEqual([]);
      expect(result.couldNotCheck.map((c) => c.id)).toEqual([ID]);
      expect(JSON.stringify(result.couldNotCheck)).toContain("depends on the webhook's settings");
    });

    it("a folder with no source is could-not-check, and so is one with a file left out", async () => {
      expect((await runOne(ID, treeOf({}))).passed).toEqual([]);
      const left = await runOne(
        ID,
        treeOf({ "a.ts": "export {};" }, { skipped: new Map([["b.ts", "too-large"]]) }),
      );
      expect(left.passed).toEqual([]);
    });

    it("a folder with a code file and no receiver passes", async () => {
      expect((await runOne(ID, treeOf({ "a.ts": "export {};" }))).passed).toEqual([ID]);
    });
  });

  it("names the file and the line, and never prints an id, a tag or the secret it reads", async () => {
    const secret = ["whsec", "not-a-real-value-0011"].join("_");
    const result = await runOne(
      ID,
      treeOf({
        [ROUTE]: receiver(
          `  const key = "${secret}";\n  revalidateTag("drafts-sentinel-tag");\n  revalidateTag(body._id);`,
        ),
      }),
    );
    expectNoneOf(result, [secret, "drafts-sentinel-tag", "SANITY_REVALIDATE_SECRET"]);
  });
});
