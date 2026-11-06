/**
 * Every flag, defined once. The parseArgs config, the --help text and the table in
 * docs/options.md are generated from this array, so they cannot drift apart.
 * Order matters: help and docs list flags in this order, most used first.
 */
export interface FlagDef {
  /** Kebab-case, without dashes: "ci", "no-open", "notify-on". */
  name: string;
  type: "boolean" | "string";
  /** Shown in --help and the docs. Plain English, no trailing full stop. */
  description: string;
  /** Environment variable that turns it on (boolean) or supplies it (string). Never a secret. */
  env?: string;
  /** The version that introduced it. */
  since: string;
  /** Commands that accept it; "*" for all. The default page check is "check". */
  commands: readonly string[];
  /** One letter, only where the flag already had one. */
  short?: string;
  /** Parsed, but left out of help and docs. */
  hidden?: boolean;
  /** Going away: using it prints one warning on stderr (see STABILITY.md). */
  deprecated?: { since: string; removeIn: string; use?: string };
}

export const FLAGS: readonly FlagDef[] = Object.freeze([
  {
    name: "ci",
    type: "boolean",
    description: 'Exit 1 when a "Fix this first" finding is found',
    env: "CI",
    since: "0.1.0",
    commands: ["check", "launch"],
  },
  {
    name: "json",
    type: "boolean",
    description: "Print the result as JSON on stdout, and nothing else",
    since: "0.1.0",
    commands: ["check", "launch"],
  },
  {
    name: "no-open",
    type: "boolean",
    description: "Do not open anything in a browser",
    since: "0.1.0",
    commands: ["check", "launch"],
  },
  {
    name: "allow-private",
    type: "boolean",
    description:
      "Allow addresses on this computer or a private network, such as 127.0.0.1 or 192.168.x.x",
    since: "0.1.0",
    commands: ["check", "launch"],
  },
  {
    name: "dns",
    type: "boolean",
    description: "launch: also check the mail records (SPF and DMARC) a DNS change would break",
    since: "0.2.0",
    commands: ["launch"],
  },
  {
    name: "quiet",
    type: "boolean",
    description: "Print only results and errors",
    since: "0.1.0",
    commands: ["*"],
  },
  {
    name: "verbose",
    type: "boolean",
    description: "Show each request, and technical detail when something goes wrong",
    since: "0.1.0",
    commands: ["*"],
  },
  {
    name: "help",
    type: "boolean",
    description: "Show this help and exit",
    since: "0.1.0",
    commands: ["*"],
    short: "h",
  },
  {
    name: "version",
    type: "boolean",
    description: "Print the version and exit",
    since: "0.1.0",
    commands: ["*"],
    short: "v",
  },
] satisfies FlagDef[]);

export function flagsFor(flags: readonly FlagDef[], command: string): FlagDef[] {
  return flags.filter((f) => f.commands.includes("*") || f.commands.includes(command));
}

export type ParseArgsOptions = Record<string, { type: "boolean" | "string"; short?: string }>;

/** The options object for node:util parseArgs (used with strict: true, allowPositionals: true). */
export function toParseArgsOptions(flags: readonly FlagDef[], command: string): ParseArgsOptions {
  const out: ParseArgsOptions = {};
  for (const f of flagsFor(flags, command))
    out[f.name] = f.short ? { type: f.type, short: f.short } : { type: f.type };
  return out;
}

export type FlagValues = Record<string, boolean | string | undefined>;

/** A boolean environment variable is on when set and not "", "0" or "false". */
export function envIsOn(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

/** Apply environment fallbacks. A flag given on the command line always wins. */
export function resolveFlags(
  parsed: FlagValues,
  env: Record<string, string | undefined>,
  flags: readonly FlagDef[],
): FlagValues {
  const out: FlagValues = { ...parsed };
  for (const f of flags) {
    if (out[f.name] !== undefined || f.env === undefined) continue;
    const value = env[f.env];
    if (f.type === "boolean") {
      if (envIsOn(value)) out[f.name] = true;
    } else if (value !== undefined && value !== "") {
      out[f.name] = value;
    }
  }
  return out;
}

function flagLabel(f: FlagDef): string {
  const long = `--${f.name}${f.type === "string" ? " <value>" : ""}`;
  return f.short ? `-${f.short}, ${long}` : `    ${long}`;
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line !== "" && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

export const HELP_WIDTH = 80;

/** Usage line, a description, then the flags in two aligned columns, wrapped at 80 columns. */
export function renderHelp(
  flags: readonly FlagDef[],
  command: string,
  head: { usage: string; summary: string; footer?: string },
): string {
  const visible = flagsFor(flags, command).filter((f) => f.hidden !== true);
  const labels = visible.map(flagLabel);
  const col = Math.max(...labels.map((l) => l.length)) + 4;
  const lines = [`Usage: ${head.usage}`, "", head.summary, "", "Options:"];
  visible.forEach((f, i) => {
    const desc = f.env ? `${f.description} [${f.env}]` : f.description;
    const [first = "", ...rest] = wrap(desc, HELP_WIDTH - col - 2);
    lines.push(`  ${(labels[i] ?? "").padEnd(col)}${first}`);
    for (const r of rest) lines.push(`  ${" ".repeat(col)}${r}`);
  });
  if (head.footer) lines.push("", head.footer);
  return lines.join("\n");
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/** Pad a Markdown table the way Prettier formats one, so the generated block is stable under it. */
export function alignTable(rows: string[][]): string {
  const widths = rows[0]?.map((_, c) => Math.max(3, ...rows.map((r) => (r[c] ?? "").length))) ?? [];
  const line = (r: string[]) => `| ${r.map((v, c) => v.padEnd(widths[c] ?? 0)).join(" | ")} |`;
  const [head = [], ...body] = rows;
  return [
    line(head),
    `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`,
    ...body.map(line),
  ].join("\n");
}

/** The Markdown table between the flags markers in docs/options.md (with a blank line each side). */
export function renderOptionsTable(flags: readonly FlagDef[]): string {
  const rows = flags
    .filter((f) => f.hidden !== true)
    .map((f) => {
      const name = `\`--${f.name}${f.type === "string" ? " <value>" : ""}\``;
      const flag = f.short ? `\`-${f.short}\`, ${name}` : name;
      return [cell(flag), cell(f.description), f.env ? `\`${f.env}\`` : "", f.since];
    });
  return `\n${alignTable([["Flag", "Does", "Environment variable", "Since"], ...rows])}\n`;
}

/** Levenshtein distance, for "did you mean". */
export function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j] ?? 0;
      prev[j] = Math.min(up + 1, (prev[j - 1] ?? 0) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length] ?? 0;
}

/** The nearest flag name within edit distance 2, for a mistyped option. */
export function nearestFlag(
  input: string,
  flags: readonly FlagDef[],
  command: string,
): string | undefined {
  const name = input.replace(/^-+/, "").split("=")[0] ?? "";
  let best: { name: string; d: number } | undefined;
  for (const f of flagsFor(flags, command)) {
    if (f.hidden === true) continue;
    const d = editDistance(name, f.name);
    if (d <= 2 && (best === undefined || d < best.d)) best = { name: f.name, d };
  }
  return best?.name;
}
