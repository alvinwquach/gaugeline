import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formPostUnguarded } from "../form-post-unguarded.js";
import { formFailureShowsSuccess } from "../form-failure-shows-success.js";
import { findingsJson } from "./tokens-docs-example.js";

const root = new URL("../../../../../../", import.meta.url);
const page = readFileSync(
  fileURLToPath(new URL("docs/checks/form-handlers-in-source.md", root)),
  "utf8",
).replace(/\r\n/g, "\n");

const block = (title: string): string[] =>
  [...page.matchAll(new RegExp('```json title="' + title + '"\\n([\\s\\S]*?)\\n```', "g"))].map(
    (m) => m[1] ?? "",
  );

describe("docs/checks/form-handlers-in-source.md", () => {
  it("shows what each check reports over its invented folder", async () => {
    for (const check of [formFailureShowsSuccess, formPostUnguarded]) {
      const shown = block(`Findings: ${check.id}`);
      expect(shown, check.id).toHaveLength(1);
      expect(shown[0], check.id).toBe(await findingsJson(check.id, "./quayside-site"));
    }
  });

  it("names both checks in its table, with their levels", () => {
    expect(page).toMatch(/\| `form-failure-shows-success` .*\| Fix this first +\|/);
    expect(page).toMatch(/\| `form-post-unguarded` .*\| Fix soon +\|/);
    expect(formFailureShowsSuccess.severity).toBe("high");
    expect(formPostUnguarded.severity).toBe("medium");
  });

  it("says it is uncited, that the documentation was checked, and that nothing was reachable", () => {
    expect(page).toMatch(/Documentation checked on: \d{4}-\d{2}-\d{2}/);
    expect(page).toContain("**uncited**");
    expect(page).toContain("could not be reached");
  });

  it("says plainly that it only reads, and that it never prints what it finds", () => {
    expect(page).toContain("They only look.");
    expect(page).toContain("makes no request and runs no code");
    expect(page).toContain("Gaugeline never submits a form");
  });

  it("has a worked example for a small client and the lists of what it leaves out", () => {
    expect(page).toMatch(/^## Example: a pub's private-dining enquiry$/m);
    expect(page).toMatch(/^## What it does not cover$/m);
    expect(page).toMatch(/^## When it cannot check$/m);
  });
});
