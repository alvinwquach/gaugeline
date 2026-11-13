import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toInboxDraft } from "../draft.js";
import { buildProposal, isRefusal, type Proposal } from "../proposal.js";
import { fixRedirect, redirectProposal } from "../redirect.js";

const FIX = fileURLToPath(new URL("../../../../fixtures/fix-proposals/", import.meta.url));
const redirects = readFileSync(`${FIX}lantern-books/public/_redirects`, "utf8");

const proposal = (): Proposal => {
  const p = redirectProposal(
    [{ path: "public/_redirects", text: redirects }],
    {
      checkId: "plan-redirect-missing",
      url: "plan.csv",
      evidence: "/old-poetry returns 404: nothing redirects it",
    },
    { from: "/old-poetry", to: "/poetry" },
    "studio/lantern-books",
  );
  if (isRefusal(p)) throw new Error(p.refused);
  return p;
};

describe("a proposal as an inbox draft: unit", () => {
  it("is one pull_request draft: a title, a description and the whole new text of the one file", () => {
    const d = toInboxDraft(proposal(), redirects);
    if (isRefusal(d)) throw new Error(d.refused);
    expect(d.kind).toBe("pull_request");
    expect(d.proposalId).toMatch(/^px_/);
    expect(d.payload.title).toBe("Redirect /old-poetry to /poetry");
    expect(d.payload.files).toEqual([
      { path: "public/_redirects", content: `${redirects}/old-poetry\t/poetry\t301\n` },
    ]);
    expect(d.payload.body).toContain("plan-redirect-missing");
    expect(d.payload.body).toContain("/old-poetry returns 404: nothing redirects it");
    expect(d.payload.body).toContain("+/old-poetry\t/poetry\t301");
    expect(d.payload.body).toContain("merge it yourself");
    // The payload names no repository, branch, recipient or draft flag: the worker fixes those.
    expect(Object.keys(d.payload).sort()).toEqual(["body", "files", "title"]);
  });
  it("is the same every time", () => {
    expect(toInboxDraft(proposal(), redirects)).toEqual(toInboxDraft(proposal(), redirects));
  });
  it("refuses when the file is no longer the text the proposal was made from", () => {
    const d = toInboxDraft(proposal(), `${redirects}/extra /elsewhere 301\n`);
    expect(isRefusal(d) ? d.refused : "").toMatch(/make the proposal again/);
  });
  it("evidence from a page cannot close the code fence or carry control characters", () => {
    const p = buildProposal({
      fixer: "redirect",
      summary: "Redirect /a to /b",
      finding: {
        checkId: "plan-redirect-missing",
        url: "plan.csv",
        evidence: "```\n# injected heading\u0007\u202E\n```",
      },
      target: { repository: null, path: "public/_redirects" },
      before: "/x /y\n",
      after: "/x /y\n/a /b 301\n",
      recheck: { checkId: "plan-redirect-missing", how: "Request /a." },
    });
    const d = toInboxDraft(p, "/x /y\n");
    if (isRefusal(d)) throw new Error(d.refused);
    expect(d.payload.body).toContain("````");
    const odd = [...d.payload.body].filter((ch) => {
      const c = ch.charCodeAt(0);
      return (c < 0x20 && ch !== "\n" && ch !== "\t") || c === 0x7f || c === 0x202e;
    });
    expect(odd).toEqual([]);
  });
  it("a Windows file keeps its line endings in the new text but not in the description", () => {
    const text = "# x\r\n/a /b 301\r\n";
    const change = fixRedirect([{ path: "_redirects", text }], { from: "/c", to: "/d" });
    if (isRefusal(change)) throw new Error(change.refused);
    const p = buildProposal({
      fixer: "redirect",
      summary: "Redirect /c to /d",
      finding: {
        checkId: "plan-redirect-missing",
        url: "plan.csv",
        evidence: "/c returns 404: nothing redirects it",
      },
      target: { repository: null, path: "_redirects" },
      before: text,
      after: change.after,
      recheck: { checkId: "plan-redirect-missing", how: "Request /c." },
    });
    const d = toInboxDraft(p, text);
    if (isRefusal(d)) throw new Error(d.refused);
    expect(d.payload.files[0]?.content).toBe("# x\r\n/a /b 301\r\n/c /d 301\r\n");
    expect(d.payload.body).not.toContain("\r");
  });
  it("refuses a draft the inbox would not keep: a file over 100,000 characters or a payload over 16 KB", () => {
    const big = `${"/a /b 301\n".repeat(2000)}`;
    const p = buildProposal({
      fixer: "redirect",
      summary: "Redirect /c to /d",
      finding: { checkId: "plan-redirect-missing", url: "plan.csv", evidence: "x" },
      target: { repository: null, path: "_redirects" },
      before: big,
      after: `${big}/c /d 301\n`,
      recheck: { checkId: "plan-redirect-missing", how: "Request /c." },
    });
    const d = toInboxDraft(p, big);
    expect(isRefusal(d) ? d.refused : "").toMatch(/16,384 bytes/);
  });
});
