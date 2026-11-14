import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkDraftPayload as inbox } from "../../apps/hosted/inbox/kinds.js";
import { preview } from "../../packages/cli/src/__tests__/helpers/redirect-preview.js";
import { main } from "../../packages/cli/src/main.js";
import { buildProposal, isRefusal, toInboxDraft } from "../../packages/core/src/fixes/index.js";
import { checkDraftPayload as writer } from "../../packages/writer/src/kinds.js";

// X70: a proposal becomes the hosted inbox's pull_request draft. What the CLI writes must be something both
// the inbox (before a person approves it) and the writer (before it sends anything) accept, byte for byte
// the same payload. The CLI and core import neither: this test is where the three meet.
const FIX = fileURLToPath(new URL("../../packages/fixtures/fix-proposals/", import.meta.url));

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-inbox-")));
  cpSync(FIX, dir, { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function run(cwd: string, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    argv,
    {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1" },
    },
    { cwd },
  );
  return { code, out: out.join(""), err: err.join("") };
}

interface Drafts {
  version: number;
  drafts: { kind: string; proposalId: string; payload: unknown }[];
}

describe("gaugeline propose --to-inbox: the draft payload under both parsers", () => {
  it("a missing redirect: every draft is accepted by the inbox and by the writer, with the same value", async () => {
    const cwd = join(dir, "lantern-books");
    const site = await preview(join(cwd, "public/_redirects"));
    try {
      const r = await run(cwd, [
        "propose",
        "--fixes",
        "--repo",
        ".",
        "--plan",
        "plan.csv",
        "--base",
        site.origin,
        "--allow-private",
        "--to-inbox",
        "inbox.json",
      ]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("2 inbox drafts written to inbox.json. Nothing was sent");
      const file = JSON.parse(readFileSync(join(cwd, "inbox.json"), "utf8")) as Drafts;
      expect(file.version).toBe(1);
      expect(file.drafts).toHaveLength(2);
      for (const d of file.drafts) {
        expect(d.kind).toBe("pull_request");
        const a = inbox(d.kind, d.payload);
        const b = writer(d.kind, d.payload);
        expect(a, JSON.stringify(a)).toMatchObject({ ok: true });
        expect(b, JSON.stringify(b)).toMatchObject({ ok: true });
        expect(a.ok && b.ok ? a.value : null).toEqual(b.ok ? b.value : undefined);
      }
    } finally {
      await site.close();
    }
  });

  it("a structured-data fix: accepted by both, and the new text is the file with the one value changed", async () => {
    const r = await run(dir, [
      "propose",
      "cedar-bar-run.json",
      "--fixes",
      "--repo",
      "cedar-bar",
      "--to-inbox",
      "inbox.json",
    ]);
    expect(r.code).toBe(0);
    const [d] = (JSON.parse(readFileSync(join(dir, "inbox.json"), "utf8")) as Drafts).drafts;
    expect(inbox("pull_request", d?.payload)).toMatchObject({ ok: true });
    expect(writer("pull_request", d?.payload)).toMatchObject({ ok: true });
    const html = readFileSync(join(dir, "cedar-bar/src/layout.html"), "utf8");
    expect((d?.payload as { files: { content: string }[] }).files[0]?.content).toBe(
      html.replace("+1 555 0100", "+1 555 0142"),
    );
  });

  it("without --to-inbox no draft file is written; with nothing to propose none is either", async () => {
    await run(dir, ["propose", "cedar-bar-run.json", "--fixes", "--repo", "cedar-bar"]);
    expect(() => readFileSync(join(dir, "inbox.json"))).toThrow();
    const r = await run(dir, [
      "propose",
      "cedar-bar-run.json",
      "--fixes",
      "--repo",
      "lantern-books",
      "--to-inbox",
      "inbox.json",
    ]);
    expect(r.out).toContain("No proposals");
    expect(() => readFileSync(join(dir, "inbox.json"))).toThrow();
  });

  it("is off by default here too: no --fixes, no file", async () => {
    const r = await run(dir, [
      "propose",
      "cedar-bar-run.json",
      "--repo",
      "cedar-bar",
      "--to-inbox",
      "inbox.json",
    ]);
    expect(r.code).toBe(2);
    expect(() => readFileSync(join(dir, "inbox.json"))).toThrow();
  });
});

describe("toInboxDraft: hostile text from a page never reaches a payload the parsers refuse", () => {
  const make = (evidence: string, summary = "Redirect /a to /b") =>
    buildProposal({
      fixer: "redirect",
      summary,
      finding: { checkId: "plan-redirect-missing", url: "plan.csv", evidence },
      target: { repository: null, path: "public/_redirects" },
      before: "/x /y\n",
      after: "/x /y\n/a /b 301\n",
      recheck: { checkId: "plan-redirect-missing", how: "Request /a." },
    });
  for (const evidence of [
    "```\n# injected\n```",
    "a\u0000b",
    "line\u2028break",
    "a\u0085b",
    "\u{1F600} emoji and \u202E reversed",
    "x".repeat(1500),
  ])
    it(`evidence ${JSON.stringify(evidence.slice(0, 20))}`, () => {
      const d = toInboxDraft(make(evidence), "/x /y\n");
      if (isRefusal(d)) throw new Error(d.refused);
      expect(inbox("pull_request", d.payload)).toMatchObject({ ok: true });
      expect(writer("pull_request", d.payload)).toMatchObject({ ok: true });
    });
  it("a title with a bidirectional control is cleaned, not refused", () => {
    const d = toInboxDraft(make("x", "Redirect /a\u202E to /b"), "/x /y\n");
    if (isRefusal(d)) throw new Error(d.refused);
    expect(d.payload.title).toBe("Redirect /a to /b");
    expect(writer("pull_request", d.payload)).toMatchObject({ ok: true });
  });
});
