import { describe, expect, it } from "vitest";
import { unifiedDiff } from "../diff.js";
import {
  PROPOSAL_VERSION,
  buildProposal,
  parseProposalFile,
  proposalFile,
  type ProposalInput,
} from "../proposal.js";

const before = "a\nb\n";
const after = "a\nb\nc\n";
const input = (over: Partial<ProposalInput> = {}): ProposalInput => ({
  fixer: "redirect",
  summary: "Redirect /old-poetry to /poetry",
  finding: {
    checkId: "plan-redirect-missing",
    url: "plan.csv",
    evidence: "/old-poetry returns 404: nothing redirects it",
  },
  target: { repository: "studio/lantern-books", path: "public/_redirects" },
  before,
  after,
  recheck: { checkId: "plan-redirect-missing", how: "Request /old-poetry on the preview." },
  ...over,
});

describe("a proposal: unit", () => {
  it("carries the finding, the target, the exact diff and how it is re-checked", () => {
    const p = buildProposal(input());
    expect(p.version).toBe(PROPOSAL_VERSION);
    expect(p.finding.checkId).toBe("plan-redirect-missing");
    expect(p.target).toEqual({ repository: "studio/lantern-books", path: "public/_redirects" });
    expect(p.change.diff).toBe(unifiedDiff("public/_redirects", before, after));
    expect(p.change.afterSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.recheck.checkId).toBe("plan-redirect-missing");
  });
  it("the same proposal built twice has the same id and diff; a different change has another id", () => {
    const a = buildProposal(input());
    const b = buildProposal(input());
    expect(b).toEqual(a);
    expect(a.id).toMatch(/^px_[0-9a-f]{16}$/);
    expect(buildProposal(input({ after: "a\nb\nd\n" })).id).not.toBe(a.id);
  });
  it("the file round-trips, and a changed diff, id or version is refused", () => {
    const file = proposalFile([buildProposal(input())]);
    expect(parseProposalFile(JSON.parse(JSON.stringify(file)))).toEqual(file);
    const tampered = JSON.parse(JSON.stringify(file)) as typeof file;
    tampered.proposals[0]!.change.diff = tampered.proposals[0]!.change.diff.replace("+c", "+evil");
    expect(() => parseProposalFile(tampered)).toThrow(/does not match/);
    expect(() => parseProposalFile({ ...file, version: 2 })).toThrow();
    expect(() => parseProposalFile({ ...file, extra: 1 })).toThrow();
  });
  it("refuses a target path that leaves the repository", () => {
    for (const path of ["../x", "/etc/passwd", "a/../b", "a\\b", ""])
      expect(() => buildProposal(input({ target: { repository: null, path } }))).toThrow();
  });
  it("refuses a change that changes nothing", () => {
    expect(() => buildProposal(input({ after: before }))).toThrow(/needs a change/);
  });
});
