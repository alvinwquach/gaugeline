import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SITES_DIR, startFixture } from "../../packages/fixtures/src/index.js";

export interface Example {
  file: string;
  /** Line of the Terminal block's opening fence. */
  line: number;
  /** Line of the Output block's opening fence, when there is one. */
  outputLine: number | null;
  command: string;
  fixture: string;
  expected: string | null;
  /** From <!-- exit: N -->; 0 by default. */
  exit: number;
}

export class DocsExampleError extends Error {}

interface Fence {
  line: number;
  info: string;
  body: string[];
}

function attr(info: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}=(?:"([^"]*)"|(\\S+))`).exec(info);
  return m
    ? (m[1] ?? m[2] ?? "")
    : new RegExp(`(?:^|\\s)${name}(?:\\s|$)`).test(info)
      ? ""
      : undefined;
}

const EXAMPLE = /^\$ (?:[A-Z][A-Z0-9_]*=\S+ )*npx gaugeline\b/;

/**
 * Every runnable example on a page: a Terminal block whose first line is "$ npx gaugeline ...",
 * the <!-- fixture: name --> (and optional <!-- exit: N -->) comments directly above it, and the
 * Output block that follows it. A block can opt out with untested="<reason>".
 */
export function extractExamples(markdown: string, file: string): Example[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const fences: (Fence & { comments: string[] })[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^```(.*)$/.exec(lines[i] ?? "");
    if (!open) continue;
    const comments: string[] = [];
    // Comments directly above the block; blank lines between them are allowed (Prettier adds one).
    for (let j = i - 1; j >= 0 && /^(<!--.*-->)?\s*$/.test(lines[j] ?? ""); j--) {
      if ((lines[j] ?? "").trim() !== "") comments.unshift(lines[j] ?? "");
    }
    let end = i + 1;
    while (end < lines.length && !(lines[end] ?? "").startsWith("```")) end++;
    fences.push({ line: i + 1, info: open[1] ?? "", body: lines.slice(i + 1, end), comments });
    i = end;
  }
  const problems: string[] = [];
  const examples: Example[] = [];
  for (let k = 0; k < fences.length; k++) {
    const f = fences[k];
    if (!f || attr(f.info, "title") !== "Terminal" || !EXAMPLE.test(f.body[0] ?? "")) continue;
    const untested = attr(f.info, "untested");
    if (untested !== undefined) {
      if (untested.trim() === "")
        problems.push(
          `${file}:${f.line}: untested needs a reason, for example untested="needs Docker".`,
        );
      continue;
    }
    const fixture = f.comments
      .map((c) => /<!--\s*fixture:\s*([a-z0-9-]+)\s*-->/.exec(c)?.[1])
      .find(Boolean);
    const exitText = f.comments.map((c) => /<!--\s*exit:\s*(\d+)\s*-->/.exec(c)?.[1]).find(Boolean);
    if (!fixture) {
      problems.push(
        `${file}:${f.line}: this example has no <!-- fixture: name --> comment directly above it.`,
      );
      continue;
    }
    const next = fences[k + 1];
    const nextIsExample =
      next && attr(next.info, "title") === "Terminal" && EXAMPLE.test(next.body[0] ?? "");
    const after = fences[k + 2];
    if (nextIsExample && after && attr(after.info, "title") === "Output") {
      problems.push(
        `${file}:${f.line}: two Terminal blocks come before one Output block; the pairing is ambiguous.`,
      );
      continue;
    }
    const output = next && attr(next.info, "title") === "Output" ? next : undefined;
    if (!output) {
      problems.push(
        `${file}:${f.line}: this example has no Output block after it and is not marked untested.`,
      );
      continue;
    }
    examples.push({
      file,
      line: f.line,
      outputLine: output.line,
      command: (f.body[0] ?? "").slice(2),
      fixture,
      expected: output.body.join("\n"),
      exit: exitText ? Number(exitText) : 0,
    });
  }
  if (problems.length > 0) throw new DocsExampleError(problems.join("\n"));
  return examples;
}

/**
 * The fixed list of replacements that make output comparable, and nothing else:
 * the fixture origin becomes the page's address, the version after "Gaugeline " becomes X.Y.Z,
 * ANSI codes go, trailing spaces go, absolute paths become ./, and ISO timestamps (named rule
 * "timestamps", for --json's startedAt) become 2026-01-01T00:00:00.000Z.
 */
// eslint-disable-next-line no-control-regex -- matching the ESC character is the point
const ANSI = /\u001b\[[0-9;]*m/g;

export function normalise(text: string, origin: string, address = "shop.example"): string {
  const page = /^[a-z]+:\/\//i.test(address)
    ? new URL(address).origin
    : `https://${address.split("/")[0]}`;
  return (
    text
      .split(origin)
      .join(page)
      .replace(/Gaugeline \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g, "Gaugeline X.Y.Z")
      .replace(ANSI, "")
      .replace(/(?<![\w.:/])(?:\/(?:[^\s/:"'<>]+\/)+|[A-Za-z]:\\(?:[^\s\\"'<>]+\\)+)/g, "./")
      .replace(
        /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g,
        "2026-01-01T00:00:00.000Z",
      )
      .split("\n")
      .map((l) => l.replace(/[ \t]+$/, ""))
      // "passed checks": one "✓ <id>" line per check that passed is left out of docs blocks; the list
      // grows with every new check and says nothing about the example.
      .filter((l) => !/^✓ [a-z0-9-]+$/.test(l))
      .join("\n")
      .replace(/\n+$/, "")
  );
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  origin: string;
  address: string;
  methods: Map<string, number>;
  maxConcurrent: number;
  /** The environment the example's own variables were given (addresses point at the local sink). */
  env: Record<string, string>;
}

/** Split `A=1 B=2 npx gaugeline shop.example --ci` into env, the address and the flags. */
/** Commands that take an address after their name, so an example can run them against a fixture site. */
const SUBCOMMANDS_WITH_ADDRESS: readonly string[] = [
  "brief",
  "advisory",
  "init",
  "deploy-gate",
  "changes",
];

export function parseCommand(command: string): {
  env: Record<string, string>;
  address: string;
  args: string[];
  /** A command word before the address (`brief`); absent for the page check. */
  subcommand?: string;
} {
  const tokens = command.match(/"[^"]*"|\S+/g) ?? [];
  const env: Record<string, string> = {};
  while (tokens[0] && /^[A-Z][A-Z0-9_]*=/.test(tokens[0])) {
    const t = tokens.shift() ?? "";
    env[t.slice(0, t.indexOf("="))] = t.slice(t.indexOf("=") + 1).replace(/^"|"$/g, "");
  }
  if (tokens[0] !== "npx" || tokens[1] !== "gaugeline")
    throw new DocsExampleError(`Not a gaugeline example: ${command}`);
  const rest = tokens.slice(2).map((t) => t.replace(/^"|"$/g, ""));
  const subcommand = SUBCOMMANDS_WITH_ADDRESS.includes(rest[0] ?? "") ? rest.shift() : undefined;
  const at = rest.findIndex((t) => !t.startsWith("-"));
  return {
    env,
    address: at === -1 ? "" : (rest[at] ?? ""),
    args: rest.filter((_, i) => i !== at),
    ...(subcommand ? { subcommand } : {}),
  };
}

export function availableFixtures(): string[] {
  return readdirSync(SITES_DIR).sort();
}

/**
 * Run one example with the built bin (never npx, never the network) against its fixture site.
 * Environment variables in the command that hold an address are pointed at a local sink.
 */
export async function runExample(
  e: Example,
  bin: string,
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  if (!availableFixtures().includes(e.fixture)) {
    throw new DocsExampleError(
      `${e.file}:${e.line}: no fixture "${e.fixture}". Available: ${availableFixtures().join(", ")}.`,
    );
  }
  const { env, address, args, subcommand } = parseCommand(e.command);
  const sinkHits: string[] = [];
  const sink = createServer((req, res) => {
    sinkHits.push(req.method ?? "");
    req.resume();
    res.writeHead(204).end();
  });
  await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
  const sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/sink`;
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env))
    childEnv[k] =
      /^https?:\/\//.test(v) || k.endsWith("_WEBHOOK") || k.endsWith("_URL") ? sinkUrl : v;
  const site = await startFixture(e.fixture);
  try {
    const path = address.includes("/")
      ? address.slice(
          address.indexOf("/", address.indexOf("://") + 3 > 2 ? address.indexOf("://") + 3 : 0),
        )
      : "/";
    const target = `${site.origin}${path.startsWith("/") ? path : "/"}`;
    // brief and advisory open nothing, so they do not take --no-open.
    const argv = [
      bin,
      ...(subcommand ? [subcommand] : []),
      target,
      ...args,
      // changes reads saved runs and APIs, never the site, so it has nothing to allow.
      ...(subcommand === "changes" ? [] : ["--allow-private"]),
      ...(args.includes("--json") ||
      subcommand === "brief" ||
      subcommand === "advisory" ||
      subcommand === "init" ||
      subcommand === "changes" ||
      subcommand === "deploy-gate"
        ? []
        : ["--no-open"]),
    ];
    // A fixture with a runs/ folder carries saved runs for `gaugeline changes`: they are copied into
    // .gaugeline/runs/<host>/ of a temporary working folder, so the example reads real history.
    const saved = join(SITES_DIR, e.fixture, "runs");
    let cwd: string | undefined;
    if (existsSync(saved)) {
      cwd = mkdtempSync(join(tmpdir(), "gaugeline-docs-runs-"));
      const host = new URL(site.origin).host.toLowerCase().replace(/[^a-z0-9.-]/g, "_");
      mkdirSync(join(cwd, ".gaugeline", "runs"), { recursive: true });
      cpSync(saved, join(cwd, ".gaugeline", "runs", host), { recursive: true });
    }
    const result = await new Promise<{ stdout: string; stderr: string; code: number }>(
      (resolve) => {
        const child = spawn(process.execPath, argv, {
          ...(cwd ? { cwd } : {}),
          env: childProcessEnv({ ...extraEnv, ...childEnv }),
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
        child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
        child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
      },
    );
    if (cwd) rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    return {
      ...result,
      origin: site.origin,
      address,
      methods: site.methods,
      maxConcurrent: site.maxConcurrent,
      env: childEnv,
    };
  } finally {
    await site.close();
    await new Promise<void>((r) => sink.close(() => r()));
  }
}

const OFFLINE_PRELOAD = fileURLToPath(
  new URL("../../packages/cli/src/__tests__/helpers/map-hosts.cjs", import.meta.url),
);

/**
 * An example runs offline: a host that is not an IP address does not resolve (the same preload the
 * CLI's own tests use), so a fixture page that links a real address (a CDN file, say) gives the same
 * output on a developer machine and on CI, where the real host would answer differently.
 */
export function offlineEnv(): Record<string, string> {
  const inherited = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : "";
  return {
    NODE_OPTIONS: `${inherited}--require "${OFFLINE_PRELOAD}"`,
    GAUGELINE_TEST_OFFLINE: "1",
  };
}

/** The parent's environment without CI and colour settings, plus NO_COLOR and the example's own. */
function childProcessEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["CI", "FORCE_COLOR", "GITHUB_ACTIONS"]) delete env[k];
  return { ...env, NO_COLOR: "1", ...offlineEnv(), ...extra };
}

/** A small unified diff of two texts, line by line (LCS). */
export function unifiedDiff(expected: string, actual: string, label: string): string {
  const a = expected.split("\n");
  const b = actual.split("\n");
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] =
        a[i] === b[j]
          ? (dp[i + 1]![j + 1] ?? 0) + 1
          : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
    }
  }
  const out = [`--- ${label} (expected)`, "+++ actual output"];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || (dp[i]![j + 1] ?? 0) >= (dp[i + 1]![j] ?? 0))) {
      out.push(`+${b[j]}`);
      j++;
    } else {
      out.push(`-${a[i]}`);
      i++;
    }
  }
  return out.join("\n");
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
function sortKeys(v: Json): Json {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortKeys(v[k] as Json)]),
    );
  return v;
}

/** Compare what ran with what the page says. JSON output is compared as parsed JSON, key order ignored. */
export function compare(e: Example, r: RunResult): string | null {
  const label = `${e.file}:${e.outputLine ?? e.line}`;
  if (r.code !== e.exit) return `${label}: expected exit ${e.exit}, got ${r.code}\n${r.stderr}`;
  const actual = normalise(r.stdout, r.origin, r.address);
  // The page side gets the same fixed rules (a version or timestamp written on the page reads as X.Y.Z / the placeholder).
  const expected = normalise(e.expected ?? "", r.origin, r.address);
  if (parseCommand(e.command).args.includes("--json")) {
    try {
      const same =
        JSON.stringify(sortKeys(JSON.parse(actual) as Json)) ===
        JSON.stringify(sortKeys(JSON.parse(expected) as Json));
      return same
        ? null
        : unifiedDiff(
            JSON.stringify(sortKeys(JSON.parse(expected) as Json), null, 2),
            JSON.stringify(sortKeys(JSON.parse(actual) as Json), null, 2),
            label,
          );
    } catch (err) {
      return `${label}: the expected or actual output is not JSON (${err instanceof Error ? err.message : String(err)})`;
    }
  }
  return actual === expected ? null : unifiedDiff(expected, actual, label);
}
