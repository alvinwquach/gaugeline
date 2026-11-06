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
  /** May be given more than once; the values arrive as a list. */
  multiple?: boolean;
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
    commands: ["check", "launch", "plan", "printed"],
  },
  {
    name: "dns",
    type: "boolean",
    description: "Also read the domain's mail records (SPF and DMARC) from DNS",
    since: "0.2.0",
    commands: ["check", "launch"],
  },
  {
    name: "since",
    type: "string",
    description:
      "Compare with this site's last run and save this one; the only value is last (.gaugeline/last-run/)",
    since: "0.2.0",
    commands: ["check"],
  },
  {
    name: "interactive",
    type: "boolean",
    description: "Open a terminal view of the results to move through, filter and dismiss findings",
    since: "0.2.0",
    commands: ["check"],
    short: "i",
  },
  {
    name: "slack",
    type: "string",
    description: "Send a summary to this Slack incoming webhook (or set GAUGELINE_SLACK_WEBHOOK)",
    since: "0.2.0",
    commands: ["check", "launch"],
  },
  {
    name: "discord",
    type: "string",
    description: "Send an embed to this Discord webhook (or set GAUGELINE_DISCORD_WEBHOOK)",
    since: "0.2.0",
    commands: ["check", "launch"],
  },
  {
    name: "webhook",
    type: "string",
    description: "POST the result as JSON to this address (or set GAUGELINE_WEBHOOK)",
    since: "0.2.0",
    commands: ["check", "launch", "digest"],
  },
  {
    name: "email",
    type: "string",
    description: "Email the full report to these addresses through Resend (or set GAUGELINE_EMAIL)",
    since: "0.2.0",
    commands: ["check", "launch", "digest"],
  },
  {
    name: "plan-only",
    type: "boolean",
    description: "Check the plan on its own, before anything is built (no requests)",
    since: "0.2.0",
    commands: ["plan"],
  },
  {
    name: "sheet",
    type: "string",
    description: "Read this tab of a workbook instead of the one with a URL column",
    since: "0.2.0",
    commands: ["plan"],
  },
  {
    name: "legacy-from",
    type: "string",
    description:
      "Read old addresses from this notes column when the plan has no Legacy URL column (repeatable)",
    since: "0.2.0",
    commands: ["plan"],
    multiple: true,
  },
  {
    name: "legacy-review",
    type: "string",
    description: "Write the old addresses read with --legacy-from to this CSV file, for review",
    since: "0.2.0",
    commands: ["plan"],
  },
  {
    name: "base",
    type: "string",
    description: "Check the plan against the site built at this address, such as a preview",
    since: "0.2.0",
    commands: ["plan"],
  },
  {
    name: "annotate",
    type: "string",
    description:
      "Write a copy of the plan with a Gaugeline column saying what is wrong on each row",
    since: "0.2.0",
    commands: ["plan"],
  },
  {
    name: "force",
    type: "boolean",
    description: "Let --annotate replace a file that already exists",
    since: "0.2.0",
    commands: ["plan"],
  },
  {
    name: "progress",
    type: "string",
    description:
      "With --base, say what was fixed and what is new since the last run (state file optional)",
    since: "0.2.0",
    commands: ["plan"],
  },
  {
    name: "all",
    type: "boolean",
    description: "With --progress, list the findings still open, not only how many",
    since: "0.2.0",
    commands: ["plan"],
  },
  {
    name: "live",
    type: "string",
    description:
      "List pages in this crawl, sitemap, Search Console export or list that the plan misses",
    since: "0.2.0",
    commands: ["plan"],
  },
  {
    name: "ignore",
    type: "string",
    description: "With --live, leave out paths matching this glob, such as /tag/* (repeatable)",
    since: "0.2.0",
    commands: ["plan"],
    multiple: true,
  },
  {
    name: "printed",
    type: "string",
    description: "With --base, add the printed register's addresses to the 301 map",
    since: "0.2.0",
    commands: ["plan"],
  },
  {
    name: "decode",
    type: "string",
    description:
      "Read the QR code in these PNG images (or a folder) and add new ones to the register",
    since: "0.2.0",
    commands: ["printed"],
    multiple: true,
  },
  {
    name: "tags",
    type: "string",
    description:
      "Query parameters that must reach the destination, as name prefixes (default utm_)",
    since: "0.2.0",
    commands: ["printed"],
  },
  {
    name: "runs",
    type: "string",
    description: "The folder of saved runs (each one saved with --json) to read",
    since: "0.2.0",
    commands: ["digest"],
  },
  {
    name: "time-zone",
    type: "string",
    description: "The time zone for dates and ages, such as America/Los_Angeles (default UTC)",
    since: "0.2.0",
    commands: ["digest"],
  },
  {
    name: "notify-on",
    type: "string",
    description: "When to send: any (something was found, the default), high or always",
    since: "0.2.0",
    commands: ["check", "launch"],
  },
  {
    name: "report-url",
    type: "string",
    description: "Link each message to a hosted copy of the report at this address",
    since: "0.2.0",
    commands: ["check", "launch"],
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
    out[f.name] = {
      type: f.type,
      ...(f.short ? { short: f.short } : {}),
      ...(f.multiple ? { multiple: true } : {}),
    };
  return out;
}

export type FlagValues = Record<string, boolean | string | string[] | undefined>;

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
