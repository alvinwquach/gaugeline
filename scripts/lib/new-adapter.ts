import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** The sources the plan edits, as text, and the files that exist. Read from disk by readAdapterState. */
export interface AdapterRepoState {
  registrySource: string;
  entriesSource: string;
  indexSource: string;
  docsIndexSource: string;
  navSource: string;
  /** Paths (relative to the root, with "/") that already exist. */
  files: Set<string>;
}

export type Step = { path: string; action: "create" | "edit"; content: string };
export type AdapterPlan = Step[];

export const REGISTRY_PATH = "packages/core/src/adapters/registry.ts";
export const ENTRIES_PATH = "packages/core/src/adapters/__tests__/entries.ts";
export const INDEX_PATH = "packages/core/src/adapters/index.ts";
export const DOCS_INDEX_PATH = "docs/integrations/index.md";
export const NAV_PATH = "docs/nav.ts";

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

/** A planned adapter's row in PLANNED_ADAPTERS, single-line or wrapped by the formatter. */
function plannedRow(registry: string, id: string): { name: string; text: string } | undefined {
  const one = new RegExp(`^  \\{ id: "${id}", name: "([^"]*)", branch: "[^"]*" \\},\\n`, "m").exec(
    registry,
  );
  if (one) return { name: one[1] ?? "", text: one[0] };
  const many = new RegExp(
    `^  \\{\\n    id: "${id}",\\n    name: "([^"]*)",\\n    branch: "[^"]*",\\n  \\},\\n`,
    "m",
  ).exec(registry);
  return many ? { name: many[1] ?? "", text: many[0] } : undefined;
}

/** Work out what the options mean, or throw a message that says what to change. */
export function resolveOptions(opts: NewAdapterOptions, registry: string): Vars {
  const { id } = opts;
  if (!ID.test(id) || id.length > 31)
    throw new Error(
      `Adapter id "${id}" must be lower-case letters, digits and hyphens, at most 31 characters, for example "strapi".`,
    );
  if (id in OTHER_BRANCHES)
    throw new Error(
      `"${id}" is not a CMS adapter: it is built by ${OTHER_BRANCHES[id]} (see PROGRESS.md).`,
    );
  if (new RegExp(`^\\s+id: "${id}",$`, "m").test(registry) && !plannedRow(registry, id))
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

  const planned = plannedRow(registry, id);
  const name = opts.name ?? planned?.name ?? titleOf(id);
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

// ---------------------------------------------------------------------------------------------
// Edits to files that already exist. Each finds one anchor and says so when it is gone.

function insertBefore(source: string, anchor: RegExp, text: string, what: string): string {
  const m = anchor.exec(source);
  if (!m)
    throw new Error(`Could not find ${what} to add the adapter next to. Nothing was written.`);
  return source.slice(0, m.index) + text + source.slice(m.index);
}

function registryEdit(source: string, v: Vars): string {
  let out = source;
  const planned = plannedRow(out, v.id);
  if (planned) out = out.replace(planned.text, "");
  out = insertBefore(
    out,
    /^import type \{ AdapterDescription[^\n]*\n/m,
    `import { ${v.prefix}_DESCRIPTION, create${v.pascal}Adapter } from "./${v.id}.js";\n`,
    "the adapters' imports in registry.ts",
  );
  const live = v.read === "live-site";
  const row = [
    "  [",
    `    ${JSON.stringify(v.id)},`,
    "    {",
    `      id: ${JSON.stringify(v.id)},`,
    `      describe: ${v.prefix}_DESCRIPTION,`,
    ...(live
      ? []
      : [
          `      // ${TODO_MARK}, after ADR-0006 has merged) a documented read-only query endpoint that needs`,
          "      // POST goes through its allowlist: add the `queryAllow` entry (method, path pattern, body shape)",
          "      // here, or delete this note. Until then every request this adapter builds is a GET.",
        ]),
    "      create: (c, settings) =>",
    `        create${v.pascal}Adapter({`,
    ...(live
      ? ["          fetcher: c.fetcher,", "          site: c.site,"]
      : ["          env: c.env,", "          fetcher: c.fetcher,"]),
    "          settings,",
    "          ...(c.sleep ? { sleep: c.sleep } : {}),",
    "        }),",
    "    },",
    "  ],",
    "",
  ].join("\n");
  return insertBefore(
    out,
    /^\]\);\n\n\/\*\* A content system the docs list/m,
    row,
    "the end of BUILT_ADAPTERS in registry.ts",
  );
}

function entriesEdit(source: string, v: Vars, entry: string): string {
  let out = insertBefore(
    source,
    /^import type \{ ContractEntry \} from "\.\/contract\.js";\n/m,
    `import { create${v.pascal}Adapter } from "../${v.id}.js";\n`,
    "the imports in entries.ts",
  );
  const fixture =
    v.read === "live-site"
      ? `${v.camel}Routes, ${v.camel}Serve, ${v.prefix}_MARKERS, ${v.prefix}_SITE`
      : `${v.camel}Transport, ${v.prefix}_MARKERS`;
  out = out.replace(
    /^(import type \{ ContractEntry \} from "\.\/contract\.js";\n)/m,
    `$1import { ${fixture} } from "./${v.id}-fixture.js";\n`,
  );
  out = insertBefore(
    out,
    /^export const ENTRIES: readonly ContractEntry\[\] = \[/m,
    `${entry}\n`,
    "ENTRIES in entries.ts",
  );
  const closed = /(export const ENTRIES: readonly ContractEntry\[\] = \[[^\]]*?)\n\];/m.exec(out);
  if (!closed)
    throw new Error("Could not find the end of ENTRIES in entries.ts. Nothing was written.");
  return out.replace(closed[0], `${closed[1]}\n  ${v.camel}Entry,\n];`);
}

function indexEdit(source: string, v: Vars): string {
  const names =
    v.read === "live-site"
      ? [`${v.prefix}_CONTENT_READ_PATH`, `${v.prefix}_DESCRIPTION`, `create${v.pascal}Adapter`]
      : [
          `${v.prefix}_API`,
          `${v.prefix}_DESCRIPTION`,
          `${v.prefix}_LIMITS`,
          `${v.prefix}_PAGE_SIZE`,
          ...(v.key !== "none" ? [`${v.prefix}_TOKEN`] : []),
          `create${v.pascal}Adapter`,
        ];
  const text = `export { ${names.join(", ")} } from "./${v.id}.js";\nexport type { ${v.pascal}AdapterOptions } from "./${v.id}.js";\n`;
  return `${source.replace(/\n*$/, "\n")}${text}`;
}

function cells(line: string): string[] {
  return line
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim());
}

function docsIndexEdit(source: string, v: Vars): string {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => l.startsWith("| Content system"));
  if (start < 0)
    throw new Error("Could not find the table of content systems in docs/integrations/index.md.");
  let end = start + 2;
  while (end < lines.length && (lines[end] ?? "").startsWith("|")) end++;
  const key =
    v.read === "live-site"
      ? `read-only (no key at all: it reads the live site only${v.key === "full-access" ? `; ${v.name}'s own key can also change the project, so Gaugeline does not use it` : ""})`
      : v.key === "none"
        ? "read-only (no key at all: it reads the platform's public API)"
        : `${v.keyKind} (${TODO_MARK}) the narrowest key, in one clause)`;
  const reads = `${TODO_MARK}) what it reads, in one sentence. [Endpoints and the key](/docs/integrations/${v.id})`;
  const row = `| ${v.name} | built | ${key} | ${reads} |`;
  const at = lines.slice(start + 2, end).findIndex((l) => cells(l)[0] === v.name);
  if (at >= 0) {
    const old = cells(lines[start + 2 + at] ?? "");
    if (!(old[1] ?? "").startsWith("planned"))
      throw new Error(`docs/integrations/index.md already has a "${v.name}" row that is built.`);
    lines[start + 2 + at] = row;
    // Built rows come first in the table, in the order they were built: move it up.
    const moved = lines.splice(start + 2 + at, 1)[0] ?? row;
    let lastBuilt = start + 1;
    for (let i = start + 2; i < end - 1; i++)
      if ((cells(lines[i] ?? "")[1] ?? "") === "built") lastBuilt = i;
    lines.splice(lastBuilt + 1, 0, moved);
  } else {
    let lastBuilt = start + 1;
    for (let i = start + 2; i < end; i++)
      if ((cells(lines[i] ?? "")[1] ?? "") === "built") lastBuilt = i;
    lines.splice(lastBuilt + 1, 0, row);
  }
  return lines.join("\n");
}

function navEdit(source: string, v: Vars): string {
  const lines = source.split("\n");
  let last = -1;
  lines.forEach((l, i) => {
    if (l.includes('slug: "integrations/')) last = i;
  });
  if (last < 0) throw new Error("Could not find the integrations pages in docs/nav.ts.");
  let end = last;
  if (!(lines[last] ?? "").trim().endsWith("},")) {
    while (end < lines.length && lines[end] !== "  },") end++;
    if (end >= lines.length)
      throw new Error("Could not read the integrations pages in docs/nav.ts.");
  }
  lines.splice(
    end + 1,
    0,
    "  {",
    `    slug: "integrations/${v.id}",`,
    `    title: ${JSON.stringify(`${v.name}: content checks for sites built on ${v.name}`)},`,
    "  },",
  );
  return lines.join("\n");
}

/** Everything the new adapter needs, as a value. Touches no disk. */
export function planNewAdapter(opts: NewAdapterOptions, repo: AdapterRepoState): AdapterPlan {
  const v = resolveOptions(opts, repo.registrySource);
  const live = v.read === "live-site";
  const dir = "packages/core/src/adapters";
  const creates: Step[] = [
    {
      path: `${dir}/${v.id}.ts`,
      action: "create",
      content: render(template(live ? "adapter-live-site.ts.tpl" : "adapter-api.ts.tpl"), v),
    },
    {
      path: `${dir}/__tests__/${v.id}-fixture.ts`,
      action: "create",
      content: render(template(live ? "fixture-live-site.ts.tpl" : "fixture-api.ts.tpl"), v),
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
  const clash = creates.find((c) => repo.files.has(c.path));
  if (clash) throw new Error(`${clash.path} already exists. Nothing was written.`);
  const entry = render(template("entry.ts.tpl"), v);
  return [
    ...creates,
    { path: REGISTRY_PATH, action: "edit", content: registryEdit(repo.registrySource, v) },
    { path: ENTRIES_PATH, action: "edit", content: entriesEdit(repo.entriesSource, v, entry) },
    { path: INDEX_PATH, action: "edit", content: indexEdit(repo.indexSource, v) },
    { path: DOCS_INDEX_PATH, action: "edit", content: docsIndexEdit(repo.docsIndexSource, v) },
    { path: NAV_PATH, action: "edit", content: navEdit(repo.navSource, v) },
  ];
}

/** Write a plan. Creates refuse to overwrite (flag wx); edits replace the file with its new content. */
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

export function readAdapterState(root: string, createdPaths: string[]): AdapterRepoState {
  const read = (p: string) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");
  return {
    registrySource: read(REGISTRY_PATH),
    entriesSource: read(ENTRIES_PATH),
    indexSource: read(INDEX_PATH),
    docsIndexSource: read(DOCS_INDEX_PATH),
    navSource: read(NAV_PATH),
    files: new Set(createdPaths.filter((p) => existsSync(join(root, p)))),
  };
}

/** The paths a plan would create, for readAdapterState to look for before planning. */
export function createdPaths(id: string): string[] {
  const dir = "packages/core/src/adapters";
  return [
    `${dir}/${id}.ts`,
    `${dir}/__tests__/${id}-fixture.ts`,
    `${dir}/__tests__/${id}-adapter.test.ts`,
    `${dir}/__tests__/${id}-docs-example.ts`,
    `${dir}/__tests__/${id}-docs.test.ts`,
    `docs/integrations/${id}.md`,
    `.changeset/c-${id}.md`,
  ];
}

/** The places an adapter lives, for printing. */
export function adapterPlaces(plan: AdapterPlan): string[] {
  return plan.map((s) => s.path);
}
