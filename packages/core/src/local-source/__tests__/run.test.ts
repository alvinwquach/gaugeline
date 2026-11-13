import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckRegistry, defineCheck } from "../../model.js";
import { parseResult } from "../../result.js";
import { readLocalSource, type SourceTree } from "../read.js";
import {
  STATIC_CHECKS,
  createStaticRegistry,
  runStaticChecks,
  staticFile,
  type LocalSourceInput,
} from "../run.js";

const NOW = new Date("2026-11-13T12:00:00Z");

const tree = (over: Partial<SourceTree> = {}): SourceTree => ({
  kind: "local-source",
  label: "./my-site",
  files: new Map(),
  skipped: new Map(),
  truncated: false,
  ...over,
});

const text = {
  what: "A test rule.",
  why: "So the runner can be tested.",
  fix: "Nothing to fix.",
  tech: "reads the files in a SourceTree",
  size: "S" as const,
  done: "Nothing is left.",
  estimateChanges: "Nothing changes it.",
  area: "Launch day" as const,
  severity: "medium" as const,
  title: "A test finding",
};

/** Finds a `TODO` in package.json, so the finding carries a file and a line. */
const todoCheck = defineCheck<LocalSourceInput>({
  ...text,
  id: "test-static-todo",
  run(input) {
    const file = staticFile(input, "package.json");
    if (file.state !== "read") return [];
    const line = file.text.split("\n").findIndex((l) => l.includes("TODO"));
    return line < 0
      ? []
      : [
          {
            checkId: "test-static-todo",
            severity: "medium",
            title: this.title,
            evidence: "package.json says TODO.",
            url: `source:${input.tree.label}`,
            source: { file: "package.json", line: line + 1 },
          },
        ];
  },
});

/** Unsure when the file it needs was not read; a pass only when it was read and clean. */
const needsLockfile = defineCheck<LocalSourceInput>({
  ...text,
  id: "test-static-lockfile",
  run(input, ctx) {
    const file = staticFile(input, "pnpm-lock.yaml");
    if (file.state === "absent") {
      ctx.couldNotCheck?.(`source:${input.tree.label}`, "there is no pnpm-lock.yaml to read");
    } else if (file.state === "skipped") {
      ctx.couldNotCheck?.(
        `source:${input.tree.label}`,
        `pnpm-lock.yaml was not read: ${file.reason}`,
      );
    }
    return [];
  },
});

const registry = (...checks: ReturnType<typeof defineCheck<LocalSourceInput>>[]): CheckRegistry => {
  const r = new CheckRegistry();
  for (const c of checks) r.register(c);
  return r;
};

describe("staticFile", () => {
  it("tells a file that was read, one that was not read and one that is not there", () => {
    const t = tree({
      files: new Map([["package.json", "{}"]]),
      skipped: new Map([[".env", "secret-looking" as const]]),
    });
    const input: LocalSourceInput = { kind: "local-source", tree: t };
    expect(staticFile(input, "package.json")).toEqual({ state: "read", text: "{}" });
    expect(staticFile(input, ".env")).toEqual({ state: "skipped", reason: "secret-looking" });
    expect(staticFile(input, "tsconfig.json")).toEqual({ state: "absent" });
  });
});

describe("the static check pack", () => {
  it("registers every check once, under a kebab-case id", () => {
    const r = createStaticRegistry();
    expect(r.size).toBe(STATIC_CHECKS.length);
    for (const c of r.all()) expect(c.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});

describe("runStaticChecks", () => {
  it("keeps a finding with its file and line, and the result is a valid result", async () => {
    const t = tree({ files: new Map([["package.json", '{\n  "name": "TODO"\n}']]) });
    const result = await runStaticChecks({ tree: t, now: NOW, registry: registry(todoCheck) });
    expect(result.url).toBe("source:./my-site");
    expect(result.findings).toEqual([
      {
        checkId: "test-static-todo",
        severity: "medium",
        title: "A test finding",
        evidence: "package.json says TODO.",
        url: "source:./my-site",
        source: { file: "package.json", line: 2 },
      },
    ]);
    expect(result.passed).toEqual([]);
    expect(parseResult(result)).toEqual(result);
  });

  it("passes a check that read what it needed and found nothing", async () => {
    const t = tree({ files: new Map([["package.json", "{}"]]) });
    const result = await runStaticChecks({ tree: t, now: NOW, registry: registry(todoCheck) });
    expect(result.passed).toEqual(["test-static-todo"]);
    expect(result.findings).toEqual([]);
  });

  it("is unsure, not passed, when the file a check needs is missing or was not read", async () => {
    const missing = await runStaticChecks({
      tree: tree(),
      now: NOW,
      registry: registry(needsLockfile),
    });
    expect(missing.passed).toEqual([]);
    expect(missing.couldNotCheck).toEqual([
      {
        id: "test-static-lockfile",
        reason: "there is no pnpm-lock.yaml to read",
        url: "source:./my-site",
      },
    ]);
    const notRead = await runStaticChecks({
      tree: tree({ skipped: new Map([["pnpm-lock.yaml", "too-large" as const]]) }),
      now: NOW,
      registry: registry(needsLockfile),
    });
    expect(notRead.passed).toEqual([]);
    expect(notRead.couldNotCheck[0]?.reason).toBe("pnpm-lock.yaml was not read: too-large");
  });

  it("never passes a check from a folder that was only partly read", async () => {
    const t = tree({ files: new Map([["package.json", "{}"]]), truncated: true });
    const result = await runStaticChecks({ tree: t, now: NOW, registry: registry(todoCheck) });
    expect(result.passed).toEqual([]);
    expect(result.couldNotCheck).toHaveLength(1);
    expect(result.couldNotCheck[0]).toMatchObject({
      id: "test-static-todo",
      url: "source:./my-site",
    });
    expect(result.couldNotCheck[0]?.reason).toContain("more files than Gaugeline reads");
  });

  it("still reports a finding from a partly read folder", async () => {
    const t = tree({ files: new Map([["package.json", "TODO"]]), truncated: true });
    const result = await runStaticChecks({ tree: t, now: NOW, registry: registry(todoCheck) });
    expect(result.findings).toHaveLength(1);
    expect(result.couldNotCheck).toEqual([]);
  });

  it("runs only the ids it is asked for, and refuses an id it does not know", async () => {
    const r = registry(todoCheck, needsLockfile);
    const one = await runStaticChecks({
      tree: tree({ files: new Map([["pnpm-lock.yaml", ""]]) }),
      now: NOW,
      registry: r,
      only: ["test-static-lockfile"],
    });
    expect(one.passed).toEqual(["test-static-lockfile"]);
    await expect(
      runStaticChecks({ tree: tree(), now: NOW, registry: r, only: ["no-such-check"] }),
    ).rejects.toThrow(/Unknown check id/);
  });
});

describe("the reader and the runner together", () => {
  let base: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "gl-static-")));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("a check sees package.json, which the content adapter refuses, and never the .env beside it", async () => {
    writeFileSync(join(base, "package.json"), '{ "name": "TODO" }');
    writeFileSync(join(base, ".env"), "KEY=value-not-kept\n");
    const t = await readLocalSource(base, undefined, "./site");
    const result = await runStaticChecks({ tree: t, now: NOW, registry: registry(todoCheck) });
    expect(result.findings.map((f) => f.checkId)).toEqual(["test-static-todo"]);
    expect(JSON.stringify(result)).not.toContain("value-not-kept");
  });
});
