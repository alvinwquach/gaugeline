import { posix } from "node:path";
import type { LocalSourceInput } from "../../local-source/run.js";

/**
 * The version of an npm package a repository installs, read from its lockfile (batch FF, the version
 * checks). Nothing is run, installed or requested: a lockfile and a package.json are text, and the
 * version is found in them with a few line rules, not a YAML or yarn parser. The same files give the
 * same answer (rule 7).
 *
 * The answer is per package.json that declares the package (a monorepo has several), and it is one
 * of two things: a version that was read (with the file and line it was read from), or "not sure"
 * with a reason in Gaugeline's words. It is never a guess: a range in package.json (`^4.0.0`) is not
 * an installed version, so with no lockfile that resolves it the answer is "not sure".
 *
 * A result holds paths, versions and reasons only. No other text of a file is ever copied into it.
 */

export type Installed =
  | {
      state: "version";
      version: string;
      /** The package.json that declares the package, and what it asks for (a version or a range). */
      declaredIn: string;
      declared: string;
      /** Where the version was read: the lockfile, or the package.json when it pins an exact version. */
      from: string;
      line: number;
    }
  | { state: "unsure"; reason: string; declaredIn: string };

const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock"];
const VERSION = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/;
const EXACT = /^[=v]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/;
const PLAIN_SPEC = /^[\^~<>=\d. xX*|-]{1,40}$/;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A declared version as it may be shown: a plain range or version, and "something other than a version" for the rest. */
const shown = (spec: string): string =>
  PLAIN_SPEC.test(spec) ? spec : "something other than a version";

interface Hit {
  version: string;
  line: number;
}

/** The line (from 1) of the first line that holds `needle`; 1 when none does. */
const lineOfText = (lines: readonly string[], needle: string): number =>
  Math.max(1, lines.findIndex((l) => l.includes(needle)) + 1);

/** pnpm-lock.yaml: the importer for `dir` ('.' is the root), then the line `name:` under it. */
function readPnpm(text: string, dir: string, name: string): Hit | undefined {
  const lines = text.split("\n");
  const key = dir === "" ? "." : dir;
  let from = 0;
  let to = lines.length;
  const importers = lines.findIndex((l) => /^importers:\s*$/.test(l));
  if (importers >= 0) {
    const start = lines.findIndex(
      (l, i) => i > importers && l.replace(/['"]/g, "").trimEnd() === `  ${key}:`,
    );
    if (start < 0) return undefined;
    from = start + 1;
    const end = lines.findIndex((l, i) => i >= from && /^ {0,2}\S/.test(l));
    to = end < 0 ? lines.length : end;
  } else {
    if (dir !== "") return undefined;
    const end = lines.findIndex((l) => /^packages:\s*$/.test(l));
    to = end < 0 ? lines.length : end;
  }
  const entry = new RegExp(`^(\\s+)['"]?${escapeRe(name)}['"]?:\\s*(.*)$`);
  for (let i = from; i < to; i++) {
    const m = entry.exec(lines[i] ?? "");
    if (m === null) continue;
    let value = (m[2] ?? "").trim();
    let at = i;
    if (value === "") {
      const indent = (m[1] ?? "").length;
      for (let j = i + 1; j < to; j++) {
        const next = lines[j] ?? "";
        if (next.trim() !== "" && next.length - next.trimStart().length <= indent) break;
        const v = /^\s+version:\s*(.+)$/.exec(next);
        if (v !== null) {
          value = (v[1] ?? "").trim();
          at = j;
          break;
        }
      }
    }
    const version = VERSION.exec(value.replace(/^['"]/, ""))?.[1];
    return version === undefined ? undefined : { version, line: at + 1 };
  }
  return undefined;
}

/** package-lock.json and npm-shrinkwrap.json: version 2 and 3 list `node_modules/<name>`, version 1 nests `dependencies`. */
function readNpm(text: string, dir: string, name: string): Hit | undefined {
  let lock: unknown;
  try {
    lock = JSON.parse(text);
  } catch {
    return undefined;
  }
  const obj = lock as {
    packages?: Record<string, { version?: unknown }>;
    dependencies?: Record<string, { version?: unknown }>;
  };
  const keys = dir === "" ? [] : [`${dir}/node_modules/${name}`];
  keys.push(`node_modules/${name}`);
  const lines = text.split("\n");
  for (const key of keys) {
    const v = obj.packages?.[key]?.version;
    if (typeof v === "string" && VERSION.test(v)) {
      return { version: v, line: lineOfText(lines, `"${key}"`) };
    }
  }
  const v1 = obj.dependencies?.[name]?.version;
  return typeof v1 === "string" && VERSION.test(v1)
    ? { version: v1, line: lineOfText(lines, `"${name}"`) }
    : undefined;
}

/** yarn.lock, classic and berry: the block whose header lists `name@<what package.json asks for>`. */
function readYarn(text: string, name: string, spec: string): Hit | undefined {
  const lines = text.split("\n");
  const wanted = new Set([`${name}@${spec}`, `${name}@npm:${spec}`]);
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i] ?? "";
    if (head === "" || /^\s/.test(head) || head.startsWith("#") || !head.endsWith(":")) continue;
    const descriptors = head
      .slice(0, -1)
      .split(",")
      .map((d) => d.trim().replace(/^["']|["']$/g, ""));
    if (!descriptors.some((d) => wanted.has(d))) continue;
    for (let j = i + 1; j < lines.length && /^\s/.test(lines[j] ?? ""); j++) {
      const v = /^\s+version:?\s+["']?([^"'\s]+)/.exec(lines[j] ?? "");
      if (v !== null && VERSION.test(v[1] ?? "")) return { version: v[1] ?? "", line: j + 1 };
    }
  }
  return undefined;
}

/** The nearest folder, from `dir` up to the root, that holds a lockfile (read or not). */
function lockfileFor(
  input: LocalSourceInput,
  dir: string,
): { path: string; base: string; read: boolean } | undefined {
  for (let base = dir; ; base = posix.dirname(base) === "." ? "" : posix.dirname(base)) {
    for (const name of LOCKFILES) {
      const path = base === "" ? name : `${base}/${name}`;
      if (input.tree.files.has(path)) return { path, base, read: true };
      if (input.tree.skipped.has(path)) return { path, base, read: false };
    }
    if (base === "") return undefined;
  }
}

/** The dependencies a package.json installs (not peer ranges: a peer range is what a library accepts, not what is installed). */
function declaredSpec(manifest: Record<string, unknown>, name: string): string | undefined {
  for (const group of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const deps = manifest[group];
    if (typeof deps === "object" && deps !== null) {
      const spec = (deps as Record<string, unknown>)[name];
      if (typeof spec === "string") return spec;
    }
  }
  return undefined;
}

/** True when an override or resolution names the package: the installed version may then differ from what is declared. */
function overridden(manifest: Record<string, unknown>, name: string): boolean {
  const pnpm = manifest.pnpm as { overrides?: unknown } | undefined;
  return [manifest.overrides, manifest.resolutions, pnpm?.overrides].some(
    (o) =>
      typeof o === "object" &&
      o !== null &&
      Object.keys(o).some((k) => k === name || k.startsWith(`${name}@`)),
  );
}

/**
 * Every package.json in the folder that declares `name`, with the version it installs. Nothing when
 * no package.json declares it (the check does not apply).
 */
export function installedVersions(input: LocalSourceInput, name: string): Installed[] {
  const out: Installed[] = [];
  const manifests = [...input.tree.files.keys()]
    .filter((p) => p === "package.json" || p.endsWith("/package.json"))
    .sort();
  for (const declaredIn of manifests) {
    const text = input.tree.files.get(declaredIn) ?? "";
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Only a file that mentions the package matters; any other broken package.json is not this check's business.
      if (text.includes(`"${name}"`))
        out.push({
          state: "unsure",
          declaredIn,
          reason: `${declaredIn} could not be read as JSON, so Gaugeline cannot tell which ${name} it installs.`,
        });
      continue;
    }
    const spec = declaredSpec(manifest, name);
    if (spec === undefined) continue;
    const unsure = (reason: string): void => {
      out.push({ state: "unsure", declaredIn, reason });
    };
    const dir = declaredIn === "package.json" ? "" : posix.dirname(declaredIn);
    const lock = lockfileFor(input, dir);
    if (lock !== undefined) {
      if (!lock.read) {
        unsure(
          `${lock.path} was not read (${input.tree.skipped.get(lock.path)}), so Gaugeline cannot tell which ${name} ${declaredIn} installs.`,
        );
        continue;
      }
      const text = input.tree.files.get(lock.path) ?? "";
      const rel = lock.base === "" ? dir : dir.slice(lock.base.length + 1);
      const hit = lock.path.endsWith("pnpm-lock.yaml")
        ? readPnpm(text, rel, name)
        : lock.path.endsWith("yarn.lock")
          ? readYarn(text, name, spec)
          : readNpm(text, rel, name);
      if (hit === undefined) {
        unsure(
          `${declaredIn} asks for ${name} ${shown(spec)}, and ${lock.path} does not give a version for it that Gaugeline can read.`,
        );
        continue;
      }
      out.push({
        state: "version",
        version: hit.version,
        declaredIn,
        declared: shown(spec),
        from: lock.path,
        line: hit.line,
      });
      continue;
    }
    const exact = EXACT.exec(spec)?.[1];
    if (exact !== undefined && !overridden(manifest, name)) {
      out.push({
        state: "version",
        version: exact,
        declaredIn,
        declared: exact,
        from: declaredIn,
        line: lineOfText(text.split("\n"), `"${name}"`),
      });
      continue;
    }
    unsure(
      `${declaredIn} asks for ${name} ${shown(spec)} and no lockfile was read, so Gaugeline cannot tell which version is installed.`,
    );
  }
  return out;
}
