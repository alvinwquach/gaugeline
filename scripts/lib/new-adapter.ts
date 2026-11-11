import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** How the adapter reads: a documented REST API, a GraphQL API (queries only), or the live site only. */
export const READ_KINDS = ["rest", "graphql", "live-site"] as const;
export type ReadKind = (typeof READ_KINDS)[number];

/** The kind of key the platform offers (see KeyKind in adapters/types.ts), or none at all. */
export const KEY_OPTIONS = ["read-only", "scoped", "full-access", "none"] as const;
export type KeyOption = (typeof KEY_OPTIONS)[number];

/** Text still to be written. gen:checks-style guard: the contract suite passes with it, a merge does not. */
export const TODO_MARK = "TODO(new:adapter";

/** The ids that belong to other branches (a recipe, git content, builders) and are not CMS adapters. */
const OTHER_BRANCHES: Readonly<Record<string, string>> = {
  "generic-api": "C-14",
  "git-content": "C-15",
  builders: "C-12",
};

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** Words, digits and a few marks: the name goes into TypeScript strings, Markdown and a table. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9 .&+-]{0,39}$/;

export interface NewAdapterOptions {
  id: string;
  name?: string | undefined;
  read?: string | undefined;
  key?: string | undefined;
}

/** An adapter id the entry files already name. A planned one has a placeholder entry the generator replaces. */
export interface KnownAdapter {
  id: string;
  /** Set for a planned adapter: the name in its placeholder entry. */
  plannedName?: string | undefined;
}

/** What the plan needs to know about the repository. Read from disk by readAdapterState. */
export interface AdapterRepoState {
  known: KnownAdapter[];
  /** Paths (relative to the root, with "/") that already exist and are not a placeholder entry. */
  files: Set<string>;
}

/** A new file, or the one placeholder entry a planned adapter has, which the built entry replaces. */
export type Step = { path: string; action: "create" | "replace"; content: string };
export type AdapterPlan = Step[];

export const ADAPTERS_DIR = "packages/core/src/adapters";

/** Everything a template may name, from the options. */
export interface Vars {
  id: string;
  name: string;
  /** SCREAMING_SNAKE prefix of the adapter's exported constants. */
  prefix: string;
  pascal: string;
  camel: string;
  read: ReadKind;
  key: KeyOption;
  /** The keyKind the adapter describes itself with. */
  keyKind: "read-only" | "scoped" | "full-access";
}

const pascalOf = (id: string): string =>
  id
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");

/** The display name for an id: "strapi-cloud" is "Strapi Cloud". */
const titleOf = (id: string): string =>
  id
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

/** Work out what the options mean, or throw a message that says what to change. */
export function resolveOptions(opts: NewAdapterOptions, known: readonly KnownAdapter[]): Vars {
  const { id } = opts;
  if (!ID.test(id) || id.length > 31)
    throw new Error(
      `Adapter id "${id}" must be lower-case letters, digits and hyphens, at most 31 characters, for example "strapi".`,
    );
  if (id in OTHER_BRANCHES)
    throw new Error(
      `"${id}" is not a CMS adapter: it is built by ${OTHER_BRANCHES[id]} (see PROGRESS.md).`,
    );
  const existing = known.find((k) => k.id === id);
  if (existing && existing.plannedName === undefined)
    throw new Error(`An adapter with the id "${id}" already exists.`);

  const keyGiven = opts.key;
  if (keyGiven !== undefined && !(KEY_OPTIONS as readonly string[]).includes(keyGiven))
    throw new Error(`Unknown --key "${keyGiven}". Use one of: ${KEY_OPTIONS.join(", ")}.`);
  const readGiven = opts.read;
  if (readGiven !== undefined && !(READ_KINDS as readonly string[]).includes(readGiven))
    throw new Error(`Unknown --read "${readGiven}". Use one of: ${READ_KINDS.join(", ")}.`);

  // A platform whose only key can write ships as a live-site adapter (PROGRESS.md, Standing orders).
  const read = (readGiven ?? (keyGiven === "full-access" ? "live-site" : "rest")) as ReadKind;
  const key = (keyGiven ?? (read === "live-site" ? "none" : "read-only")) as KeyOption;
  if (key === "full-access" && read !== "live-site")
    throw new Error(
      "A platform whose only key can also write is read from the live site only: use --read live-site (or leave --read out). Gaugeline does not ask for a key that can change a client's site.",
    );
  if (read === "live-site" && (key === "read-only" || key === "scoped"))
    throw new Error(
      `--read live-site is for a platform with no read API (--key none) or whose key can write (--key full-access). A platform with a ${key} key is read through its API: use --read rest or --read graphql.`,
    );

  const name = opts.name ?? existing?.plannedName ?? titleOf(id);
  if (!NAME.test(name))
    throw new Error(
      `--name "${name}" must be a plain name: letters, digits, spaces and . & + - only, at most 40 characters.`,
    );
  const pascal = pascalOf(id);
  return {
    id,
    name,
    prefix: id.toUpperCase().replace(/-/g, "_"),
    pascal,
    camel: pascal.charAt(0).toLowerCase() + pascal.slice(1),
    read,
    key,
    keyKind: key === "scoped" ? "scoped" : "read-only",
  };
}

// ---------------------------------------------------------------------------------------------
// Templates: plain text with `$NAME$`-style variables and `#if`, `#else`, `#end` lines.

const TEMPLATES = fileURLToPath(new URL("../templates/new-adapter/", import.meta.url));

function flagsOf(v: Vars): Record<string, boolean> {
  return {
    key: v.key !== "none" && v.read !== "live-site",
    rest: v.read === "rest",
    graphql: v.read === "graphql",
    live: v.read === "live-site",
    "full-access": v.key === "full-access",
  };
}

/** Render a template: drop the lines of a branch not taken, then fill in the variables. */
export function render(template: string, v: Vars): string {
  const flags = flagsOf(v);
  const vars: Record<string, string> = {
    ID: v.id,
    NAME: v.name,
    P: v.prefix,
    PASCAL: v.pascal,
    CAMEL: v.camel,
    KEYKIND: v.keyKind,
    API: `https://api.${v.id}.example/v1`,
    PAGE: "100",
    FULLNOTE:
      v.key === "full-access"
        ? `; ${v.name}'s own key can also change the project, so Gaugeline does not use it`
        : "",
  };
  const out: string[] = [];
  // One entry per open #if: was its condition true, and has #else flipped it.
  const stack: { on: boolean }[] = [];
  const live = () => stack.every((s) => s.on);
  for (const line of template.split("\n")) {
    const d = /^\s*#(if|else|end)\b\s*(.*)$/.exec(line);
    if (d) {
      const [, kind, rest = ""] = d;
      if (kind === "if") {
        const name = rest.trim();
        const negate = name.startsWith("!");
        const flag = flags[negate ? name.slice(1) : name];
        if (flag === undefined) throw new Error(`Template condition "${name}" is not known.`);
        stack.push({ on: negate ? !flag : flag });
      } else if (kind === "else") {
        const top = stack.at(-1);
        if (!top) throw new Error("Template #else without #if.");
        top.on = !top.on;
      } else if (!stack.pop()) throw new Error("Template #end without #if.");
      continue;
    }
    if (live()) out.push(line);
  }
  if (stack.length > 0) throw new Error("Template #if without #end.");
  const text = out.join("\n").replace(/\$([A-Z]+)\$/g, (m, name: string) => vars[name] ?? m);
  const left = /\$[A-Z]+\$/.exec(text);
  if (left) throw new Error(`Template variable ${left[0]} was not filled in.`);
  return text;
}

const template = (file: string): string =>
  readFileSync(join(TEMPLATES, file), "utf8").replace(/\r\n/g, "\n");

/** The paths the plan writes for an id, in the order it writes them. The entry file is the second. */
export function createdPaths(id: string): string[] {
  const dir = ADAPTERS_DIR;
  return [
    `${dir}/${id}.ts`,
    `${dir}/${id}.entry.ts`,
    `${dir}/__tests__/${id}-fixture.ts`,
    `${dir}/__tests__/${id}.contract.ts`,
    `${dir}/__tests__/${id}-adapter.test.ts`,
    `${dir}/__tests__/${id}-docs-example.ts`,
    `${dir}/__tests__/${id}-docs.test.ts`,
    `docs/integrations/${id}.md`,
    `.changeset/c-${id}.md`,
  ];
}

/** Everything the new adapter needs, as a value: new files only. Touches no disk. */
export function planNewAdapter(opts: NewAdapterOptions, repo: AdapterRepoState): AdapterPlan {
  const v = resolveOptions(opts, repo.known);
  const live = v.read === "live-site";
  const dir = ADAPTERS_DIR;
  const planned = repo.known.some((k) => k.id === v.id && k.plannedName !== undefined);
  const plan: AdapterPlan = [
    {
      path: `${dir}/${v.id}.ts`,
      action: "create",
      content: render(template(live ? "adapter-live-site.ts.tpl" : "adapter-api.ts.tpl"), v),
    },
    {
      path: `${dir}/${v.id}.entry.ts`,
      action: planned ? "replace" : "create",
      content: render(template("adapter-entry.ts.tpl"), v),
    },
    {
      path: `${dir}/__tests__/${v.id}-fixture.ts`,
      action: "create",
      content: render(template(live ? "fixture-live-site.ts.tpl" : "fixture-api.ts.tpl"), v),
    },
    {
      path: `${dir}/__tests__/${v.id}.contract.ts`,
      action: "create",
      content: render(template("contract.ts.tpl"), v),
    },
    {
      path: `${dir}/__tests__/${v.id}-adapter.test.ts`,
      action: "create",
      content: render(template("adapter-test.ts.tpl"), v),
    },
    {
      path: `${dir}/__tests__/${v.id}-docs-example.ts`,
      action: "create",
      content: render(template("docs-example.ts.tpl"), v),
    },
    {
      path: `${dir}/__tests__/${v.id}-docs.test.ts`,
      action: "create",
      content: render(template("docs-test.ts.tpl"), v),
    },
    {
      path: `docs/integrations/${v.id}.md`,
      action: "create",
      content: render(template("docs-page.md.tpl"), v),
    },
    {
      path: `.changeset/c-${v.id}.md`,
      action: "create",
      content: `---\n"gaugeline": minor\n---\n\n${v.name}: content checks for sites built on ${v.name}. ${TODO_MARK}) one line a user would understand: what the adapter reads and which key it asks for.\n`,
    },
  ];
  const clash = plan.find((c) => c.action === "create" && repo.files.has(c.path));
  if (clash) throw new Error(`${clash.path} already exists. Nothing was written.`);
  return plan;
}

/** Write a plan. Creates refuse to overwrite (flag wx); a replace rewrites the planned adapter's placeholder entry. */
export function applyAdapterPlan(plan: AdapterPlan, root: string): void {
  for (const step of plan)
    if (step.action === "create" && existsSync(join(root, step.path)))
      throw new Error(`${step.path} already exists.`);
  for (const step of plan) {
    const full = join(root, step.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, step.content, { flag: step.action === "create" ? "wx" : "w" });
  }
}

/**
 * Reads which adapters the entry files name (adapters/*.entry.ts, plus the builders' table, whose ids are in
 * builder-platforms.ts) and which of the files the plan would create already exist.
 */
export function readAdapterState(root: string, id: string): AdapterRepoState {
  const dir = join(root, ADAPTERS_DIR);
  const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const known = new Map<string, KnownAdapter>();
  const planned = /\bid: "([a-z0-9-]+)",\s*name: "([^"\n]*)",\s*status: "planned"/g;
  const sources = readdirSync(dir)
    .filter((f) => /\.entry\.ts$/.test(f) || f === "builder-platforms.ts")
    .map((f) => ({ file: f, text: read(join(dir, f)) }));
  for (const { text } of sources)
    for (const m of text.matchAll(/\bid: "([a-z0-9-]+)"/g))
      known.set(m[1] ?? "", { id: m[1] ?? "" });
  for (const { text } of sources)
    for (const m of text.matchAll(planned))
      known.set(m[1] ?? "", { id: m[1] ?? "", plannedName: m[2] ?? "" });
  const own = `${ADAPTERS_DIR}/${id}.entry.ts`;
  const isPlanned = known.get(id)?.plannedName !== undefined;
  return {
    known: [...known.values()],
    files: new Set(
      createdPaths(id).filter((p) => !(isPlanned && p === own) && existsSync(join(root, p))),
    ),
  };
}

/** The places an adapter lives, for printing. */
export function adapterPlaces(plan: AdapterPlan): string[] {
  return plan.map((s) => s.path);
}
