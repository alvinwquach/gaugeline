import { describe, expect, it } from "vitest";
import { webhookMissingSecretStatus } from "../webhook-missing-secret-status.js";
import { fixtureTree, runOne, treeOf } from "./helpers.js";

const ID = "webhook-missing-secret-status";
const run = (files: Record<string, string>, over = {}) =>
  runOne(webhookMissingSecretStatus, treeOf(files, over));

/** A receiver whose branch for a missing secret is `onMissing`; the rest is a normal verified handler. */
const handler = (onMissing: string, extra = "") => `
import { revalidateTag } from "next/cache";
import { parseBody } from "next-sanity/webhook";
export async function POST(req: Request) {
  const secret = process.env.SANITY_REVALIDATE_SECRET;
  ${onMissing}
  const { isValidSignature } = await parseBody(req, secret);
  ${extra}
  if (isValidSignature !== true) return new Response("no", { status: 401 });
  revalidateTag("event");
  return new Response("ok");
}`;

describe("webhook-missing-secret-status: fixtures", () => {
  it("fails the folder whose receiver answers 401 when the secret is missing", async () => {
    const out = await runOne(webhookMissingSecretStatus, await fixtureTree(ID, "fail"));
    expect(out.passed).toEqual([]);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({
      checkId: ID,
      severity: "high",
      evidence: "app/api/revalidate/route.ts:8: a missing webhook secret is answered with 401.",
      url: "source:./webhook-missing-secret-status/fail",
      source: { file: "app/api/revalidate/route.ts", line: 8 },
    });
  });

  it("passes the folder whose receiver answers 500", async () => {
    const out = await runOne(webhookMissingSecretStatus, await fixtureTree(ID, "pass"));
    expect(out.findings).toEqual([]);
    expect(out.couldNotCheck).toEqual([]);
    expect(out.passed).toEqual([ID]);
  });
});

describe("webhook-missing-secret-status: the status a missing secret gets", () => {
  it.each([
    ["a 5xx status option", `if (!secret) return new Response("x", { status: 503 });`],
    ["a thrown error", `if (!secret) { throw new Error("secret not set"); }`],
    ["res.status(500)", `if (!secret) return res.status(500).json({});`],
    [
      "a missing secret tested against undefined",
      `if (secret === undefined) throw new Error("x");`,
    ],
    [
      "the secret tested together with the header",
      `if (!secret || !req.headers) throw new Error("x");`,
    ],
  ])("passes %s", async (_name, guard) => {
    const out = await run({ "app/api/hook/route.ts": handler(guard) });
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([ID]);
  });

  it.each([
    ["a 400", `if (!secret) { return NextResponse.json({}, { status: 400 }); }`, "400"],
    ["res.status(403)", `if (!secret) return res.status(403).end();`, "403"],
    ["a 200, which accepts anyone", `if (!secret) return NextResponse.json({ ok: true });`, "200"],
    ["a 204", `if (!secret) return new Response(null, { status: 204 });`, "204"],
  ])("fails %s", async (_name, guard, code) => {
    const out = await run({ "app/api/hook/route.ts": handler(guard) });
    expect(out.passed).toEqual([]);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.evidence).toBe(
      `app/api/hook/route.ts:6: a missing webhook secret is answered with ${code}.`,
    );
  });

  it("reads the secret from an alias of process.env and from process.env itself", async () => {
    const direct = `import { parseBody } from "next-sanity/webhook";
export async function POST(req: Request) {
  if (!process.env.SANITY_WEBHOOK_SECRET) return new Response("x", { status: 400 });
  return new Response("ok");
}`;
    const out = await run({ "app/api/hook/route.ts": direct });
    expect(out.findings).toHaveLength(1);
    const destructured = handler(
      `if (!HOOK_SECRET) return new Response("x", { status: 401 });`,
    ).replace(
      "const secret = process.env.SANITY_REVALIDATE_SECRET;",
      "const { HOOK_SECRET } = process.env; const secret = HOOK_SECRET;",
    );
    const out2 = await run({ "app/api/hook/route.ts": destructured });
    expect(out2.findings).toHaveLength(1);
  });

  it("fails the null that parseBody returns with no secret when it is tested with === false", async () => {
    const files = {
      "app/api/hook/route.ts": `import { parseBody } from "next-sanity/webhook";
export async function POST(req: Request) {
  const { isValidSignature } = await parseBody(req, process.env.SANITY_REVALIDATE_SECRET);
  if (isValidSignature === false) return new Response("no", { status: 401 });
  return new Response("ok");
}`,
    };
    const out = await run(files);
    expect(out.passed).toEqual([]);
    expect(out.findings[0]?.evidence).toBe(
      "app/api/hook/route.ts:4: with no secret parseBody returns null, and this test lets null through.",
    );
    expect(out.findings[0]?.source).toEqual({ file: "app/api/hook/route.ts", line: 4 });
  });
});

describe("webhook-missing-secret-status: not sure is not a pass", () => {
  it("is unsure when the receiver has no branch for a missing secret", async () => {
    const out = await run({ "app/api/hook/route.ts": handler("") });
    expect(out.passed).toEqual([]);
    expect(out.findings).toEqual([]);
    expect(out.couldNotCheck).toEqual([
      {
        id: ID,
        reason:
          "app/api/hook/route.ts has no branch for a missing secret, so Gaugeline cannot tell what it answers.",
        url: "source:./my-site",
      },
    ]);
  });

  it("is unsure when the status is not a number it can read", async () => {
    const out = await run({
      "app/api/hook/route.ts": handler(`if (!secret) return new Response("x", { status: CODE });`),
    });
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck[0]?.reason).toBe(
      "app/api/hook/route.ts answers a missing secret with a status Gaugeline cannot read as a number.",
    );
  });

  it("is unsure when the branch for a missing secret does not stop the request", async () => {
    const out = await run({
      "app/api/hook/route.ts": handler(`if (!secret) { console.warn("no secret"); }`),
    });
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck).toHaveLength(1);
  });

  it("is unsure when the receiver reads no secret from the environment", async () => {
    const out = await run({
      "app/api/hook/route.ts": `import { isValidSignature } from "@sanity/webhook";
export async function POST(req: Request) { return new Response(String(isValidSignature)); }`,
    });
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck[0]?.reason).toBe(
      "app/api/hook/route.ts reads no secret from process.env, so Gaugeline cannot tell what it answers when the secret is missing.",
    );
  });

  it("is unsure, not passed, when a code file was left out of the folder", async () => {
    const out = await run(
      { "package.json": "{}" },
      { skipped: { "app/api/big/route.ts": "too-large" } },
    );
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck[0]?.reason).toContain("app/api/big/route.ts");
  });

  it("passes a folder with no webhook receiver at all", async () => {
    const out = await run({ "app/page.tsx": "export default function P() { return null; }" });
    expect(out.passed).toEqual([ID]);
  });

  it("is unsure for a receiver that passes and another that cannot be read", async () => {
    const out = await run({
      "app/api/a/route.ts": handler(`if (!secret) throw new Error("x");`),
      "app/api/b/route.ts": handler(""),
    });
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck).toHaveLength(1);
  });
});

describe("webhook-missing-secret-status: what it ignores and what it never prints", () => {
  it("ignores a guard inside a comment or a string", async () => {
    const files = {
      "app/api/hook/route.ts": handler(`
  // if (!secret) return new Response("x", { status: 401 });
  const note = "if (!secret) return new Response('x', { status: 401 })";
  if (!secret) throw new Error(note);`),
    };
    const out = await run(files);
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([ID]);
  });

  it("does not read a test file", async () => {
    const out = await run({
      "app/api/hook/route.test.ts": handler(
        `if (!secret) return new Response("x", { status: 401 });`,
      ),
    });
    expect(out.findings).toEqual([]);
  });

  it("prints the file, the line and the status, never the secret, the body or an id in the file", async () => {
    const hardcoded = ["whsec", "not-a-real-value-0001"].join("_");
    const out = await run({
      "app/api/hook/route.ts": handler(
        `if (!secret) return NextResponse.json({ error: "${hardcoded}", id: "drafts.abc123" }, { status: 401 });`,
        `const fallback = "${hardcoded}";`,
      ),
    });
    expect(out.findings).toHaveLength(1);
    const printed = JSON.stringify(out);
    expect(printed).not.toContain(hardcoded);
    expect(printed).not.toContain("drafts.abc123");
    expect(printed).not.toContain("SANITY_REVALIDATE_SECRET");
  });
});
