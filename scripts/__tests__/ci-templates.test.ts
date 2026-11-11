import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const read = (p: string) => readFileSync(root(p), "utf8");

const FILES = {
  gitlab: "examples/ci/gitlab-ci.yml",
  bitbucket: "examples/ci/bitbucket-pipelines.yml",
  circleci: "examples/ci/circleci-config.yml",
} as const;

type Doc = Record<string, unknown>;
const doc = (k: keyof typeof FILES) => parse(read(FILES[k])) as Doc;

/** Every string in a parsed document, so a check can look at all of it. */
function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v && typeof v === "object") return Object.values(v).flatMap(strings);
  return [];
}

const nodeMajor = (image: string) => Number(/(?:node|cimg\/node):(\d+)/.exec(image)?.[1]);

describe("CI templates parse and share one contract", () => {
  for (const [name, file] of Object.entries(FILES)) {
    const text = read(file);
    const lines = strings(parse(text));

    it(`${name}: is valid YAML that runs the documented command`, () => {
      expect(lines.some((s) => /npx --yes gaugeline "\$SITE_URL" --ci --no-open/.test(s))).toBe(
        true,
      );
    });

    it(`${name}: uses only documented flags, never a probing flag in the command`, () => {
      const commands = text.split("\n").filter((l) => /npx --yes gaugeline/.test(l));
      expect(commands.length).toBeGreaterThan(0);
      for (const c of commands) expect(c).not.toMatch(/--owner-consent|--routes|--allow-private/);
    });

    it(`${name}: has no secret written inline; keys appear only as $VARIABLE references`, () => {
      expect(text).not.toMatch(/https:\/\/hooks\.slack\.com\/services\/\w/);
      expect(text).not.toMatch(/sk_(live|test)_|re_[A-Za-z0-9]{10,}|ghp_/);
      for (const l of text.split("\n")) {
        const m = /^\s*[^#\s][^#]*?(GAUGELINE_\w+|RESEND_API_KEY)\s*[:=]\s*(\S+)/.exec(l);
        if (m) expect(m[2], l).toMatch(/^["']?\$/);
        expect(l).not.toMatch(/\becho\b[^#]*\$(GAUGELINE_\w+|RESEND_API_KEY)/);
        expect(l).not.toMatch(/\bset -x\b/);
      }
    });

    it(`${name}: passes the exit code through unchanged (0, 1, 2)`, () => {
      // The exit code is read back and re-raised, never mapped to another number.
      expect(text).not.toMatch(/exit (3|4|5|255)\b/);
      expect(text).not.toMatch(/\|\|\s*true\b/);
    });

    it(`${name}: keeps the npm cache`, () => {
      expect(text).toMatch(/\.npm/);
    });

    it(`${name}: never suggests probing without the opt-in sentence`, () => {
      if (/owner-consent/.test(text))
        expect(text).toMatch(/only on sites you own or have permission to test/i);
    });
  }
});

describe("GitLab CI template", () => {
  const d = doc("gitlab");
  const job = d["gaugeline"] as Doc;
  it("uses a Node 22 or newer image", () => {
    expect(nodeMajor(String(job["image"]))).toBeGreaterThanOrEqual(22);
  });
  it("saves the report even when the check fails", () => {
    const artifacts = job["artifacts"] as Doc;
    expect(artifacts["when"]).toBe("always");
    expect(artifacts["paths"]).toEqual(["gaugeline-report.html"]);
  });
  it("runs on schedules and by hand, and caches the npm cache", () => {
    expect(JSON.stringify(job["rules"])).toContain('$CI_PIPELINE_SOURCE == \\"schedule\\"');
    expect((job["cache"] as Doc)["paths"]).toEqual([".npm/"]);
  });
  it("does not allow the job to fail on exit 1 or 2", () => {
    expect(job["allow_failure"]).toBeUndefined();
  });
});

describe("Bitbucket Pipelines template", () => {
  const d = doc("bitbucket");
  const custom = (d["pipelines"] as Doc)["custom"] as Record<string, { step: Doc }[]>;
  const steps = custom["gaugeline-nightly"]!.map((s) => s.step);
  it("uses a Node 22 or newer image", () => {
    expect(nodeMajor(String(d["image"]))).toBeGreaterThanOrEqual(22);
  });
  it("has a scheduled custom pipeline whose first step stores the report and the exit code", () => {
    expect(steps).toHaveLength(2);
    expect(steps[0]!["artifacts"]).toEqual(["gaugeline-report.html", "gaugeline-exit-code"]);
    expect(steps[0]!["caches"]).toEqual(["npm"]);
  });
  it("re-raises the saved exit code in the second step", () => {
    expect(strings(steps[1]).join("\n")).toMatch(/exit "\$\(cat gaugeline-exit-code\)"/);
  });
  it("defines the npm cache", () => {
    expect(((d["definitions"] as Doc)["caches"] as Doc)["npm"]).toBe("~/.npm");
  });
});

describe("CircleCI template", () => {
  const d = doc("circleci");
  const job = (d["jobs"] as Record<string, Doc>)["gaugeline"]!;
  const steps = job["steps"] as unknown[];
  it("is config version 2.1 with a Node 22 or newer image", () => {
    expect(d["version"]).toBe(2.1);
    const docker = job["docker"] as { image: string }[];
    expect(nodeMajor(docker[0]!.image)).toBeGreaterThanOrEqual(22);
  });
  it("stores the report, and re-raises the saved exit code last", () => {
    expect(JSON.stringify(steps)).toContain('"store_artifacts"');
    expect(JSON.stringify(steps)).toContain("gaugeline-report.html");
    const last = steps.at(-1) as { run: { command: string } };
    expect(last.run.command).toMatch(/exit "\$\(cat gaugeline-exit-code\)"/);
  });
  it("runs nightly on main through a workflow schedule", () => {
    const wf = (d["workflows"] as Record<string, Doc>)["nightly"]!;
    const trigger = (wf["triggers"] as { schedule: { cron: string; filters: Doc } }[])[0]!;
    expect(trigger.schedule.cron).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(JSON.stringify(trigger.schedule.filters)).toContain("main");
  });
});

describe("docs/guides/ci-templates.md", () => {
  const page = read("docs/guides/ci-templates.md");
  it("embeds each template file exactly, so the page and the files never drift", () => {
    for (const file of Object.values(FILES)) {
      const name = file.split("/").pop()!;
      const re = new RegExp(
        "```yaml title=" + name.replace(/\./g, "\\.") + "\\n([\\s\\S]*?)\\n```",
      );
      const m = re.exec(page);
      expect(m, `${name} block`).not.toBeNull();
      expect(m![1] + "\n").toBe(read(file));
    }
  });
  it("explains the exit codes, the variables and the opt-in sentence", () => {
    expect(page).toMatch(/\| `0`/);
    expect(page).toMatch(/\| `1`/);
    expect(page).toMatch(/\| `2`/);
    expect(page).toContain("SITE_URL");
    expect(page).toContain("GAUGELINE_SLACK_WEBHOOK");
    expect(page).toContain("only on sites you own or have permission to test");
  });
  it("is in the docs sidebar", () => {
    expect(read("docs/nav.ts")).toContain('slug: "guides/ci-templates"');
  });
});
