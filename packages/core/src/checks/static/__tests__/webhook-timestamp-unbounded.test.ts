import { describe, expect, it } from "vitest";
import { webhookTimestampUnbounded } from "../webhook-timestamp-unbounded.js";
import { fixtureTree, runOne, treeOf } from "./helpers.js";

const ID = "webhook-timestamp-unbounded";
const run = (files: Record<string, string>, over = {}) =>
  runOne(webhookTimestampUnbounded, treeOf(files, over));

const receiver = (after: string) => `
export async function POST(req: Request) {
  const header = req.headers.get("sanity-webhook-signature") ?? "";
  const [, timestamp = ""] = /^t=(\\d+),v1=(.+)$/.exec(header) ?? [];
  const sentAt = Number(timestamp);
  ${after}
  return new Response("ok");
}`;

describe("webhook-timestamp-unbounded: fixtures", () => {
  it("fails the receiver that reads the timestamp and never compares it with now", async () => {
    const out = await runOne(webhookTimestampUnbounded, await fixtureTree(ID, "fail"));
    expect(out.passed).toEqual([]);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({
      checkId: ID,
      severity: "medium",
      evidence:
        "app/api/revalidate/route.ts:13: the signed timestamp is read but never compared with the time now.",
    });
  });

  it("passes the receiver that rejects a timestamp too far from now, either way", async () => {
    const out = await runOne(webhookTimestampUnbounded, await fixtureTree(ID, "pass"));
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([ID]);
  });
});

describe("webhook-timestamp-unbounded: the limits", () => {
  it.each([
    [
      "Math.abs of the distance",
      "if (Math.abs(Date.now() - sentAt) > 300000) throw new Error('x');",
    ],
    [
      "Math.abs the other way round",
      "if (Math.abs(sentAt - Date.now()) > 300000) throw new Error('x');",
    ],
    [
      "an age test and a future test",
      "const now = Date.now(); if (now - sentAt > 300000 || sentAt - now > 60000) throw new Error('x');",
    ],
  ])("passes %s", async (_n, after) => {
    const out = await run({ "app/api/hook/route.ts": receiver(after) });
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([ID]);
  });

  it("fails an age limit with no limit for the future", async () => {
    const out = await run({
      "app/api/hook/route.ts": receiver("if (Date.now() - sentAt > 300000) throw new Error('x');"),
    });
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.evidence).toBe(
      "app/api/hook/route.ts:6: the timestamp has an age limit but no limit for one in the future.",
    );
  });

  it("fails a test against the future with no age limit", async () => {
    const out = await run({
      "app/api/hook/route.ts": receiver(
        "const now = Date.now(); if (sentAt > now) throw new Error('x');",
      ),
    });
    expect(out.findings[0]?.evidence).toContain("no age limit, only a test against the future");
  });

  it("is unsure when now is used in a way it cannot read as a limit", async () => {
    const out = await run({
      "app/api/hook/route.ts": receiver("log(Date.now()); check(sentAt);"),
    });
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck[0]?.reason).toBe(
      "app/api/hook/route.ts compares something with the time now in a way Gaugeline cannot read as a limit on the timestamp.",
    );
  });
});

describe("webhook-timestamp-unbounded: the official helper is advice, never a failure", () => {
  it("reports a low finding for a receiver that only uses the helper", async () => {
    const out = await run({
      "app/api/hook/route.ts": `import { parseBody } from "next-sanity/webhook";
export async function POST(req: Request) {
  const { isValidSignature } = await parseBody(req, process.env.SANITY_REVALIDATE_SECRET);
  return new Response(String(isValidSignature));
}`,
    });
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ severity: "low" });
    expect(out.findings[0]?.evidence).toBe(
      "app/api/hook/route.ts:3: this receiver uses the official verification helper, which makes no age check (read in @sanity/webhook 4.0.4). Advice, not a failure.",
    );
  });
});

describe("webhook-timestamp-unbounded: not sure, and what it never prints", () => {
  it("is unsure when the receiver shows no timestamp and no helper", async () => {
    const out = await run({
      "app/api/hook/route.ts": `export async function POST(req: Request) { return new Response(req.headers.get("sanity-webhook-signature")); }`,
    });
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck[0]?.reason).toBe(
      "app/api/hook/route.ts reads no signed timestamp Gaugeline can see; it may be in a module it did not match.",
    );
  });

  it("is unsure, not passed, when a code file was left out", async () => {
    const out = await run(
      { "app/page.tsx": "export default () => null;" },
      { skipped: { "lib/big.ts": "unreadable" } },
    );
    expect(out.passed).toEqual([]);
  });

  it("passes a folder with no receiver, and ignores a limit written in a comment", async () => {
    expect((await run({ "app/page.tsx": "export default () => null;" })).passed).toEqual([ID]);
    const out = await run({
      "app/api/hook/route.ts": receiver(
        "// if (Math.abs(Date.now() - sentAt) > 300000) throw new Error('x');",
      ),
    });
    expect(out.findings).toHaveLength(1);
  });

  it("prints the file and the line, never the timestamp, the signature or the body", async () => {
    const value = ["v1", "not-a-real-value-0004"].join("=");
    const out = await run({
      "app/api/hook/route.ts": receiver(`const sample = "t=1700000000,${value}"; void sample;`),
    });
    expect(out.findings).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain(value);
    expect(JSON.stringify(out)).not.toContain("1700000000");
  });
});
