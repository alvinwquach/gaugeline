import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MAX_COMMENT_FINDINGS, MAX_PR_COMMENT_CHARS, UNTRUSTED_CAPS } from "@gaugeline/core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { FLAGS } from "../flags.js";

/**
 * docs/ci.md, "A summary comment on the pull request": the comment it shows is the one the end-to-end test posts
 * (the golden file), the workflow it shows is one GitHub would accept for this feature, the command uses real
 * flags, and the numbers it states are the ones in the code.
 */
const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\r\n/g, "\n");
const page = read("../../../../docs/ci.md");
const section = page.slice(
  page.indexOf("### A summary comment on the pull request"),
  page.indexOf("### Try the upload once"),
);

describe("docs/ci.md: the summary comment", () => {
  it("shows the comment the golden file holds, byte for byte", () => {
    const golden = read("./golden/pr-comment.golden.txt").trimEnd();
    expect(section).toContain("```text title=Comment\n" + golden + "\n```");
  });

  it("the workflow it shows asks for pull-requests: write, runs on pull_request, and pins every action by commit", () => {
    const yaml = /```yaml title=\.github\/workflows\/gaugeline\.yml\n([\s\S]*?)\n```/.exec(
      section,
    )![1]!;
    const wf = parse(yaml) as {
      on: unknown;
      permissions: Record<string, string>;
      jobs: { check: { steps: Array<{ uses?: string; with?: Record<string, string> }> } };
    };
    expect(wf.on).toBe("pull_request");
    expect(yaml).not.toContain("pull_request_target:");
    expect(wf.permissions["pull-requests"]).toBe("write");
    const steps = wf.jobs.check.steps;
    for (const st of steps.filter((x) => x.uses?.startsWith("actions/")))
      expect(st.uses).toMatch(/@[0-9a-f]{40}$/);
    const ours = steps.find((x) => x.uses?.startsWith("alvinwquach/gaugeline@"));
    expect(ours?.with).toMatchObject({ comment: "true", baseline: "main/gaugeline.baseline.json" });
    // The baseline comes from main, in a folder the pull request's own checkout does not contain.
    expect(steps.some((x) => x.with?.path === "main" && /base_ref/.test(x.with.ref ?? ""))).toBe(
      true,
    );
  });

  it("the command it shows uses flags that exist", () => {
    const cmd = /\$ npx gaugeline (.*)\n/.exec(section)![1]!;
    for (const f of cmd.match(/--[a-z-]+/g) ?? [])
      expect(
        FLAGS.some((d) => `--${d.name}` === f),
        f,
      ).toBe(true);
    expect(FLAGS.find((f) => f.name === "pr-comment")).toMatchObject({
      type: "boolean",
      commands: ["check"],
    });
  });

  it("states the numbers the code uses", () => {
    expect(section).toContain(`up to ${MAX_COMMENT_FINDINGS} finding titles`);
    expect(section).toContain(`cut at ${UNTRUSTED_CAPS.title} characters`);
    expect(section).toContain(
      `capped at ${MAX_PR_COMMENT_CHARS.toLocaleString("en-US")} characters`,
    );
  });

  it("the action's inputs table lists comment and baseline, and says what the token is", () => {
    for (const name of ["comment", "baseline"])
      expect(page).toMatch(new RegExp("\\| `" + name + "`"));
    expect(section).toContain("could not post the comment (read-only token)");
    expect(page).not.toContain("planned for v1.1");
  });
});
