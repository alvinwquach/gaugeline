import { posix } from "node:path";
import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import { stripComments } from "./indexing-source.js";

// [GC] no source found (uncited): that a target of es5 makes a Next.js app bigger or down-levels its code. Next's TypeScript page (https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/03-api-reference/05-config/02-typescript.mdx, read 2026-11-13) says nothing about `target`, and its browser-support guide is not at that path in v16.4.1 (404). The check text therefore says what es5 is (an old language level) and does not say what Next does with it.

const ID = "tsconfig-target-es5";
const TSCONFIG = /(?:^|\/)tsconfig\.json$/;
const MAX_DEPTH = 6;

/** What a tsconfig says about `target`, following `extends` inside the folder. */
type Target =
  | { state: "target"; value: string; file: string; line: number }
  | { state: "none" }
  | { state: "unsure"; reason: string };

/** A tsconfig is JSON with comments and trailing commas; both are removed before it is parsed. */
function parseTsconfig(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(stripComments(text).replace(/,(\s*[}\]])/g, "$1"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function targetOf(input: LocalSourceInput, path: string, depth = 0): Target {
  const { files, skipped } = input.tree;
  const text = files.get(path);
  if (text === undefined)
    return {
      state: "unsure",
      reason: `${path} was not read (${skipped.get(path) ?? "it is not in the folder"}).`,
    };
  const config = parseTsconfig(text);
  if (config === undefined)
    return { state: "unsure", reason: `${path} could not be read as a tsconfig.` };
  const options = config.compilerOptions;
  const own =
    typeof options === "object" && options !== null
      ? (options as Record<string, unknown>).target
      : undefined;
  if (typeof own === "string") {
    const at = text.split("\n").findIndex((l) => /["']target["']\s*:/.test(l));
    return { state: "target", value: own, file: path, line: Math.max(1, at + 1) };
  }
  const extended = config.extends;
  if (extended === undefined) return { state: "none" };
  if (depth >= MAX_DEPTH)
    return { state: "unsure", reason: `${path} extends more files than Gaugeline follows.` };
  const list = Array.isArray(extended) ? extended : [extended];
  // A later entry of `extends` overrides an earlier one, so the last that says anything decides.
  for (const entry of [...list].reverse()) {
    if (typeof entry !== "string" || !entry.startsWith("."))
      return {
        state: "unsure",
        reason: `${path} extends a configuration that is not a file in the folder, so Gaugeline cannot tell its target.`,
      };
    const base = posix.join(posix.dirname(path), entry);
    const next = [base, `${base}.json`, `${base}/tsconfig.json`].find(
      (c) => files.has(c) || skipped.has(c),
    );
    if (next === undefined)
      return {
        state: "unsure",
        reason: `${path} extends ${base}, which is not in the folder, so Gaugeline cannot tell its target.`,
      };
    const found = targetOf(input, next, depth + 1);
    if (found.state !== "none") return found;
  }
  return { state: "none" };
}

/** The first number of what package.json asks for; a spec with none (latest, a link) is treated as modern. */
function modernNext(manifest: unknown): boolean | undefined {
  if (typeof manifest !== "object" || manifest === null) return undefined;
  for (const group of ["dependencies", "devDependencies"]) {
    const deps = (manifest as Record<string, unknown>)[group];
    const spec =
      typeof deps === "object" && deps !== null
        ? (deps as Record<string, unknown>).next
        : undefined;
    if (typeof spec === "string") {
      const major = /\d+/.exec(spec)?.[0];
      return major === undefined || Number(major) >= 13;
    }
  }
  return undefined;
}

/** True when the nearest package.json above `file` declares Next.js 13 or later. */
function inModernNextApp(input: LocalSourceInput, file: string): boolean {
  for (let dir = posix.dirname(file); ; dir = posix.dirname(dir)) {
    const path = dir === "." ? "package.json" : `${dir}/package.json`;
    const text = input.tree.files.get(path);
    if (text !== undefined) {
      try {
        return modernNext(JSON.parse(text)) === true;
      } catch {
        return false;
      }
    }
    if (dir === "." || dir === "/") return false;
  }
}

export const tsconfigTargetEs5 = defineCheck<LocalSourceInput>({
  id: ID,
  size: "S",
  done: "tsconfig.json sets a target of es2017 or later, or none.",
  estimateChanges:
    "One line in tsconfig.json; larger if an old library in the project relies on the old setting.",
  area: "Visitors",
  severity: "low",
  title: "tsconfig targets es5 on a modern Next.js app",
  what: "The tsconfig.json of a Next.js 13 or later app sets compilerOptions.target to es5, directly or through a tsconfig it extends.",
  why: "es5 is the language level of browsers from over a decade ago. A modern Next.js app is built for current browsers, so the setting asks tools that read it to treat modern language features as missing and to write them out the long way, which can make the code bigger and slower for no visitor's benefit. Gaugeline has not confirmed what Next.js itself does with it.",
  fix: "Set target to es2017 or later (create-next-app's own tsconfig is a good reference), and check that the project still compiles. If an old library needs the setting, keep it in that library's own tsconfig.",
  tech: "static, reads tsconfig.json files and package.json as text and makes no request; only a tsconfig whose nearest package.json declares next 13 or later is read; comments and trailing commas are tolerated; extends is followed through relative files inside the folder (the last entry of an array wins); compilerOptions.target compared without case is es5: a finding that names the file and line that sets it; an extends that is a package, a file not in the folder, a file that was not read or that cannot be parsed, with no target of its own, is not sure; no target set, or es2017 or later, passes; the value of no other option is printed",
  run(input, ctx) {
    const url = `source:${input.tree.label}`;
    const out: Finding[] = [];
    const roots = [...input.tree.files.keys(), ...input.tree.skipped.keys()]
      .filter((p) => TSCONFIG.test(p))
      .sort();
    for (const path of roots) {
      if (!input.tree.files.has(path)) {
        if (inModernNextApp(input, path))
          ctx.couldNotCheck?.(url, `${path} was not read (${input.tree.skipped.get(path)}).`);
        continue;
      }
      if (!inModernNextApp(input, path)) continue;
      const t = targetOf(input, path);
      if (t.state === "unsure") ctx.couldNotCheck?.(url, t.reason);
      else if (t.state === "target" && t.value.toLowerCase() === "es5")
        out.push({
          checkId: ID,
          severity: "low",
          title: this.title,
          evidence:
            t.file === path
              ? `${t.file}:${t.line}: compilerOptions.target is es5.`
              : `${path} extends ${t.file}, which sets target to es5 at line ${t.line}.`,
          url,
          source: { file: t.file, line: t.line },
        });
    }
    return out;
  },
});
