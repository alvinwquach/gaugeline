import {
  parseResult,
  TERMINAL_EVIDENCE_MAX,
  UNTRUSTED_CAPS,
  wrapFindingForAgent,
} from "@gaugeline/core";
import { startFixture } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { runBin } from "./helpers/bin.js";

// eslint-disable-next-line no-control-regex -- the point is to find control characters
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u{E0000}-\u{E007F}]/u;

describe("the built CLI against the hostile fixture: e2e", () => {
  it("prints page text with no escape sequence and no line past the cap; the hidden directive is still reported", async () => {
    const site = await startFixture("hostile");
    try {
      const r = await runBin([site.origin, "--allow-private"]);
      expect(r.status).toBe(0);
      expect(r.stdout).not.toMatch(CONTROL);
      for (const line of r.stdout.split("\n"))
        expect(line.length).toBeLessThanOrEqual(TERMINAL_EVIDENCE_MAX + 8);
      expect(r.stdout).toContain("Hidden text on the page gives orders to AI assistants");
      expect(r.stdout).toContain("This page has two titles");
      expect(r.stdout).toContain("[cut]");
    } finally {
      await site.close();
    }
  });

  it("--json keeps the findings; wrapped for an agent, every page-derived field is labelled and capped", async () => {
    const site = await startFixture("hostile");
    try {
      const r = await runBin([site.origin, "--allow-private", "--json"]);
      expect(r.status).toBe(0);
      const result = parseResult(JSON.parse(r.stdout));
      const ids = result.findings.map((f) => f.checkId);
      expect(ids).toEqual(expect.arrayContaining(["hidden-ai-directive", "duplicate-title"]));
      for (const f of result.findings) {
        const w = wrapFindingForAgent(f);
        for (const field of [w.title, w.evidence, w.url]) {
          expect(field.untrusted).toBe(true);
          expect(field.text).not.toMatch(CONTROL);
          expect(field.text.length).toBeLessThanOrEqual(UNTRUSTED_CAPS.evidence * 2);
        }
      }
    } finally {
      await site.close();
    }
  });
});
