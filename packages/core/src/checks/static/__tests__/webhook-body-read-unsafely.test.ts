import { describe, expect, it } from "vitest";
import { webhookBodyReadUnsafely } from "../webhook-body-read-unsafely.js";
import { fixtureTree, runOne, treeOf } from "./helpers.js";

const ID = "webhook-body-read-unsafely";
const run = (files: Record<string, string>, over = {}) =>
  runOne(webhookBodyReadUnsafely, treeOf(files, over));

const CAP = `if (Number(req.headers.get("content-length") ?? 0) > 65536) return new Response("big", { status: 413 });`;
const receiver = (body: string) => `import { createHmac } from "node:crypto";
export async function POST(req: Request) {
  const header = req.headers.get("sanity-webhook-signature") ?? "";
  ${body}
  return new Response("ok");
}`;

describe("webhook-body-read-unsafely: fixtures", () => {
  it("fails the receiver that parses first and reads with no limit", async () => {
    const out = await runOne(webhookBodyReadUnsafely, await fixtureTree(ID, "fail"));
    expect(out.passed).toEqual([]);
    expect(out.findings.map((f) => f.evidence)).toEqual([
      "app/api/revalidate/route.ts:12: the body is parsed with req.json(), so the signature cannot be checked over the raw body.",
      "app/api/revalidate/route.ts:12: the body is read in full with no size limit.",
    ]);
    expect(out.findings[0]).toMatchObject({ checkId: ID, severity: "medium" });
  });

  it("passes the receiver that checks the size, reads the raw text, verifies, then parses", async () => {
    const out = await runOne(webhookBodyReadUnsafely, await fixtureTree(ID, "pass"));
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([ID]);
  });
});

describe("webhook-body-read-unsafely: the patterns", () => {
  it("fails JSON.parse before the signature step, and passes it after", async () => {
    const before = await run({
      "app/api/h/route.ts": receiver(
        `${CAP}\n  const raw = await req.text(); const data = JSON.parse(raw); createHmac("sha256", "k").update(raw);`,
      ),
    });
    expect(before.findings.map((f) => f.evidence)).toEqual([
      "app/api/h/route.ts:5: the body is parsed with JSON.parse before the signature is checked.",
    ]);
    const after = await run({
      "app/api/h/route.ts": receiver(
        `${CAP}\n  const raw = await req.text(); createHmac("sha256", "k").update(raw); const data = JSON.parse(raw);`,
      ),
    });
    expect(after.passed).toEqual([ID]);
  });

  it.each([
    [
      "the content-length header",
      `const n = req.headers.get("content-length"); const raw = await req.text();`,
    ],
    ["a stream reader", `const r = req.body?.getReader(); const raw = await req.text();`],
    ["a limit option", `const raw = await getRawBody(req, { limit: 65536 });`],
  ])("accepts %s as a size limit", async (_n, body) => {
    const out = await run({ "app/api/h/route.ts": receiver(body) });
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([ID]);
  });

  it("fails a raw read with no limit, and the helper's parseBody with no limit", async () => {
    const raw = await run({ "app/api/h/route.ts": receiver(`const raw = await req.text();`) });
    expect(raw.findings.map((f) => f.evidence)).toEqual([
      "app/api/h/route.ts:4: the body is read in full with no size limit.",
    ]);
    const helper = await run({
      "app/api/h/route.ts": `import { parseBody } from "next-sanity/webhook";
export async function POST(req: Request) {
  const { body } = await parseBody(req, process.env.SANITY_REVALIDATE_SECRET);
  return Response.json(body);
}`,
    });
    expect(helper.findings.map((f) => f.evidence)).toEqual([
      "app/api/h/route.ts:3: the body is read in full with no size limit.",
    ]);
  });

  it("fails Next's parsed req.body in a pages/api route, and passes it with bodyParser false", async () => {
    const page = (config: string) => `${config}
export default function handler(req, res) {
  const sig = req.headers["sanity-webhook-signature"];
  const body = req.body; // content-length is checked elsewhere
  res.status(200).end(String(sig && body));
}`;
    const bad = await run({ "pages/api/hook.ts": page("") });
    expect(
      bad.findings.some((f) => f.evidence.includes("Next parses the body of this route")),
    ).toBe(true);
    const good = await run({
      "pages/api/hook.ts": page("export const config = { api: { bodyParser: false } };").replace(
        "content-length is checked elsewhere",
        "x",
      ),
    });
    expect(good.findings.some((f) => f.evidence.includes("Next parses the body"))).toBe(false);
  });
});

describe("webhook-body-read-unsafely: not sure, and what it never prints", () => {
  it("is unsure when the receiver reads no body Gaugeline can see", async () => {
    const out = await run({ "app/api/h/route.ts": receiver("") });
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck).toEqual([
      {
        id: ID,
        reason:
          "app/api/h/route.ts reads no request body Gaugeline can see; it may be read in a module it did not match.",
        url: "source:./my-site",
      },
    ]);
  });

  it("is unsure, not passed, when a code file was left out; passes a folder with no receiver", async () => {
    const left = await run({ "a.ts": "export {};" }, { skipped: { "lib/big.ts": "too-large" } });
    expect(left.passed).toEqual([]);
    expect((await run({ "a.ts": "export {};" })).passed).toEqual([ID]);
  });

  it("ignores req.json() in a comment, and never prints the body", async () => {
    const value = ["body", "not-a-real-value-0005"].join("-");
    const out = await run({
      "app/api/h/route.ts": receiver(
        `// const x = await req.json();\n  const raw = await req.text(); const note = "${value}"; ${CAP}`,
      ),
    });
    expect(out.findings).toEqual([]);
    expect(JSON.stringify(out)).not.toContain(value);
  });
});
