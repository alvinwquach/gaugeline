import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cmsTokenInClientCode } from "../cms-token-in-client-code.js";
import { webhookUrlHardcoded } from "../webhook-url-hardcoded.js";
import { findingsJson } from "./tokens-docs-example.js";

const root = new URL("../../../../../../", import.meta.url);
const page = readFileSync(
  fileURLToPath(new URL("docs/checks/tokens-in-source.md", root)),
  "utf8",
).replace(/\r\n/g, "\n");

const block = (title: string): string[] =>
  [...page.matchAll(new RegExp('```json title="' + title + '"\\n([\\s\\S]*?)\\n```', "g"))].map(
    (m) => m[1] ?? "",
  );

describe("docs/checks/tokens-in-source.md", () => {
  it("shows what each check reports over its invented folder", async () => {
    for (const check of [cmsTokenInClientCode, webhookUrlHardcoded]) {
      const shown = block(`Findings: ${check.id}`);
      expect(shown, check.id).toHaveLength(1);
      expect(shown[0], check.id).toBe(await findingsJson(check.id));
    }
  });

  it("names both checks in its table, with their levels", () => {
    for (const check of [cmsTokenInClientCode, webhookUrlHardcoded]) {
      expect(page).toMatch(new RegExp("\\| `" + check.id + "` .*\\| Fix this first +\\|"));
      expect(check.severity).toBe("high");
    }
  });

  it("says when the documentation was checked, marks the citation [docs], and the rest uncited", () => {
    expect(page).toMatch(/Documentation checked on: \d{4}-\d{2}-\d{2}/);
    expect(page).toContain("[docs]");
    expect(page).toContain("**uncited**");
    expect(page).toContain("could not be reached");
  });

  it("says plainly that it only reads, and that it never prints what it finds", () => {
    expect(page).toContain("They only look.");
    expect(page).toContain("never the value it found");
  });

  it("has a worked example for a small client and a list of what it does not cover", () => {
    expect(page).toMatch(/^## Example: a pub's menu/m);
    expect(page).toMatch(/^## What it does not cover$/m);
    expect(page).toMatch(/^## When it cannot check$/m);
  });

  it("shows no address or token", () => {
    expect(page).not.toMatch(/hooks\.slack\.com\/services\/\w/);
    expect(page).not.toMatch(/example\.test\/webhooks\/\w/);
    expect(page).not.toMatch(/\bsk[A-Za-z0-9]{30,}/);
  });
});
