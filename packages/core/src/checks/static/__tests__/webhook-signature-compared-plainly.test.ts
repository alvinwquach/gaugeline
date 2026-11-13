import { describe, expect, it } from "vitest";
import { webhookSignatureComparedPlainly } from "../webhook-signature-compared-plainly.js";
import { fixtureTree, runOne, treeOf } from "./helpers.js";

const ID = "webhook-signature-compared-plainly";
const run = (files: Record<string, string>, over = {}) =>
  runOne(webhookSignatureComparedPlainly, treeOf(files, over));

const receiver = (compare: string, imports = "") => `${imports}
export async function POST(req: Request) {
  const header = req.headers.get("sanity-webhook-signature") ?? "";
  const signature = header;
  const expected = sign(header);
  ${compare}
  return new Response("ok");
}`;

describe("webhook-signature-compared-plainly: fixtures", () => {
  it("fails the receiver that compares with !==", async () => {
    const out = await runOne(webhookSignatureComparedPlainly, await fixtureTree(ID, "fail"));
    expect(out.passed).toEqual([]);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({
      checkId: ID,
      severity: "medium",
      evidence:
        "app/api/revalidate/route.ts:16: the signature is compared with a plain comparison.",
      source: { file: "app/api/revalidate/route.ts", line: 16 },
    });
  });

  it("passes the receiver that uses timingSafeEqual", async () => {
    const out = await runOne(webhookSignatureComparedPlainly, await fixtureTree(ID, "pass"));
    expect(out.findings).toEqual([]);
    expect(out.couldNotCheck).toEqual([]);
    expect(out.passed).toEqual([ID]);
  });
});

describe("webhook-signature-compared-plainly: what counts", () => {
  it.each([
    ["!==", "if (signature !== expected) return new Response('no', { status: 401 });"],
    ["===", "if (expected === signature) return new Response('ok');"],
    ["==", "if (parts.v1Signature == expected) return new Response('ok');"],
    [
      "a shared secret in the query",
      "if (url.searchParams.get('secret') !== process.env.HOOK_SECRET) throw new Error('no');",
    ],
  ])("fails %s", async (_n, compare) => {
    const out = await run({ "app/api/hook/route.ts": receiver(compare) });
    expect(out.passed).toEqual([]);
    expect(out.findings).toHaveLength(1);
  });

  it.each([
    [
      "timingSafeEqual",
      "if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error('x');",
    ],
    ["a length test", "if (signature.length !== expected.length) throw new Error('x');"],
    ["a missing header", "if (signature === undefined || signature === '') throw new Error('x');"],
    ["a boolean from a helper", "if (isValidSignature === false) throw new Error('x');"],
    ["a type test", "if (typeof signature !== 'string') throw new Error('x');"],
    ["a comparison that is not a signature", "if (req.method !== 'POST') throw new Error('x');"],
  ])("does not fail %s", async (_n, compare) => {
    const out = await run({ "app/api/hook/route.ts": receiver(compare) });
    expect(out.findings.filter((f) => f.severity !== "low")).toEqual([]);
  });

  it("passes a receiver with timingSafeEqual, and is unsure of one with no comparison at all", async () => {
    const safe = await run({
      "app/api/hook/route.ts": receiver("if (!timingSafeEqual(a, b)) throw new Error('x');"),
    });
    expect(safe.passed).toEqual([ID]);
    const none = await run({ "app/api/hook/route.ts": receiver("") });
    expect(none.passed).toEqual([]);
    expect(none.couldNotCheck).toEqual([
      {
        id: ID,
        reason:
          "app/api/hook/route.ts has no signature comparison Gaugeline can read; it may be in a module it did not match.",
        url: "source:./my-site",
      },
    ]);
  });
});

describe("webhook-signature-compared-plainly: the official helper is advice, never a failure", () => {
  it("reports a low finding that says so", async () => {
    const out = await run({
      "app/api/hook/route.ts": `import { isValidSignature } from "@sanity/webhook";
export async function POST(req: Request) {
  const ok = await isValidSignature(await req.text(), req.headers.get("sanity-webhook-signature") ?? "", process.env.SANITY_REVALIDATE_SECRET ?? "");
  return new Response(ok ? "ok" : "no", { status: ok ? 200 : 401 });
}`,
    });
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ severity: "low" });
    expect(out.findings[0]?.evidence).toBe(
      "app/api/hook/route.ts:3: this receiver uses the official verification helper, which compares signatures with a plain comparison (read in @sanity/webhook 4.0.4). Advice, not a failure.",
    );
  });
});

describe("webhook-signature-compared-plainly: not sure, and what it never prints", () => {
  it("is unsure, not passed, when a code file was left out", async () => {
    const out = await run(
      { "app/page.tsx": "export default () => null;" },
      { skipped: { "lib/big.ts": "too-large" } },
    );
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck[0]?.reason).toContain("lib/big.ts");
  });

  it("passes a folder with no receiver", async () => {
    expect((await run({ "app/page.tsx": "export default () => null;" })).passed).toEqual([ID]);
  });

  it("ignores a comparison inside a comment or a string", async () => {
    const out = await run({
      "app/api/hook/route.ts": receiver(
        `// if (signature !== expected) throw new Error('x');\n  const s = "signature !== expected"; if (!timingSafeEqual(a, b)) throw new Error(s);`,
      ),
    });
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([ID]);
  });

  it("prints the file and the line, never the values compared", async () => {
    const value = ["whsec", "not-a-real-value-0003"].join("_");
    const out = await run({
      "app/api/hook/route.ts": receiver(
        `const known = "${value}"; if (signature !== known) throw new Error("${value}");`,
      ),
    });
    expect(out.findings).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain(value);
  });
});
