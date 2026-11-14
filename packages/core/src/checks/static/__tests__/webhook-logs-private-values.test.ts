import { describe, expect, it } from "vitest";
import { webhookLogsPrivateValues } from "../webhook-logs-private-values.js";
import { fixtureTree, runOne, treeOf } from "./helpers.js";

const ID = "webhook-logs-private-values";
const run = (files: Record<string, string>, over = {}) =>
  runOne(webhookLogsPrivateValues, treeOf(files, over));

const receiver = (log: string) => `
export async function POST(req: Request) {
  const secret = process.env.SANITY_REVALIDATE_SECRET;
  const header = req.headers.get("sanity-webhook-signature") ?? "";
  const raw = await req.text();
  const payload = JSON.parse(raw) as { _id: string; _type: string };
  ${log}
  return new Response("ok");
}`;

describe("webhook-logs-private-values: fixtures", () => {
  it("fails the receiver that logs the body, an id and the secret, and names each place", async () => {
    const out = await runOne(webhookLogsPrivateValues, await fixtureTree(ID, "fail"));
    expect(out.passed).toEqual([]);
    expect(out.findings.map((f) => f.evidence)).toEqual([
      "app/api/revalidate/route.ts:29: a log call includes the request body.",
      "app/api/revalidate/route.ts:30: a log call includes a document id and the secret.",
    ]);
    expect(out.findings[0]).toMatchObject({
      checkId: ID,
      severity: "medium",
      source: { file: "app/api/revalidate/route.ts", line: 29 },
    });
  });

  it("passes the receiver that logs only the document type", async () => {
    const out = await runOne(webhookLogsPrivateValues, await fixtureTree(ID, "pass"));
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([ID]);
  });
});

describe("webhook-logs-private-values: what counts", () => {
  it.each([
    ["the body", `console.log(raw);`, "the request body"],
    ["JSON of the payload", `console.error(JSON.stringify(payload));`, "the request body"],
    ["a document id", `logger.info("published", payload._id);`, "a document id"],
    ["the signature", `console.warn(\`bad signature \${header}\`, signature);`, "the signature"],
    ["the secret itself", `console.debug(process.env.SANITY_REVALIDATE_SECRET);`, "the secret"],
    ["the secret through its alias", `log.info(secret);`, "the secret"],
  ])("fails a log of %s", async (_n, log, kind) => {
    const out = await run({ "app/api/h/route.ts": receiver(log) });
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.evidence).toBe(`app/api/h/route.ts:7: a log call includes ${kind}.`);
  });

  it("does not fail a log of the type, a status or a count, or the word body in a string", async () => {
    const out = await run({
      "app/api/h/route.ts": receiver(
        `console.info("body received, id ok", payload._type, 200, raw.length);`,
      ),
    });
    expect(out.passed).toEqual([ID]);
  });

  it("reads a log call that spans lines, and ignores one in a comment", async () => {
    const out = await run({
      "app/api/h/route.ts": receiver(
        `// console.log(raw);\n  console.log(\n    "x",\n    raw,\n  );`,
      ),
    });
    expect(out.findings.map((f) => f.source?.line)).toEqual([8]);
  });
});

describe("webhook-logs-private-values: not sure, and what it never prints", () => {
  it("is unsure, not passed, when a code file was left out; passes a folder with no receiver", async () => {
    const left = await run({ "a.ts": "export {};" }, { skipped: { "lib/big.ts": "unreadable" } });
    expect(left.passed).toEqual([]);
    expect((await run({ "a.ts": "export {};" })).passed).toEqual([ID]);
  });

  it("never prints the body, the id or the secret it finds", async () => {
    const secret = ["whsec", "not-a-real-value-0006"].join("_");
    const out = await run({
      "app/api/h/route.ts": receiver(
        `const k = "${secret}"; console.log("drafts.abc123", raw, payload._id, secret, k);`,
      ),
    });
    expect(out.findings).toHaveLength(1);
    const printed = JSON.stringify(out);
    for (const leak of [secret, "drafts.abc123", "SANITY_REVALIDATE_SECRET"])
      expect(printed).not.toContain(leak);
  });
});
