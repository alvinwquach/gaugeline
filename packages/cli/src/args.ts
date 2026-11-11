import { parseArgs } from "node:util";
import { SECRET_FLAGS, minorExponent, parseAddress, safeLogoUrl } from "@gaugeline/core";
import { HELP } from "./help.js";
import { FLAGS, nearestFlag, resolveFlags, toParseArgsOptions, type FlagDef } from "./flags.js";

export const USAGE_LINE = "gaugeline <address> [options]";
export const COMMAND = "check";
/** Subcommands, by their first word on the command line. "check" is the default. */
export const SUBCOMMANDS = [
  "launch",
  "brief",
  "view",
  "digest",
  "plan",
  "printed",
  "snapshot",
  "cutover",
  "verify",
  "run",
  "open",
  "assert",
  "ads",
  "tags",
  "delivery",
  "platform",
  "query",
  "emails",
  "renewals",
  "handoff",
  "cost",
  "backups",
  "audit",
  "migration",
  "advisory",
] as const;
export type CliCommand = "check" | (typeof SUBCOMMANDS)[number];

/** The root command's help, from help.ts. */
export const USAGE = HELP[""] ?? "";

export const USAGE_HINT = `${USAGE_LINE}, for example: gaugeline example.com (see gaugeline --help)`;
export const UNKNOWN_FLAG_HINT = "Run gaugeline --help to see every option.";

/** The options of `gaugeline brief`, checked when the command line is read. */
export interface BriefFlags {
  business?: string;
  /** --rate, whole currency units, as minor units: 110 is 11000. */
  rateMinor?: number;
  hoursPerPoint?: number;
  /** --out: the Markdown file to write, as typed. Absent: print the work order. */
  out?: string;
  force: boolean;
}

/** The options of `gaugeline handoff`, checked when the command line is read. */
export interface HandoffFlags {
  /** --out: the folder the three report files go in, as typed. Absent: the default folder, or none with --json. */
  out?: string;
  force: boolean;
}

/** Where `gaugeline handoff` writes when --out is not given. */
export const HANDOFF_DEFAULT_OUT = "gaugeline-handoff";

/** The options of `gaugeline audit --pack`, checked when the command line is read. */
export interface AuditFlags {
  /** --business: the prospect's business, shown in the heading. */
  business?: string;
  /** --brand, --brand-logo and --brand-contact: who the pack is from. They replace the same fields in gaugeline.services.json. */
  brand: { name?: string; logoUrl?: string; contact?: string };
  /** --out: the folder the two pack files go in, as typed. */
  out: string;
  force: boolean;
}

/** Where `gaugeline audit --pack` writes when --out is not given. */
export const AUDIT_DEFAULT_OUT = "gaugeline-audit";

export interface RunFlags {
  /** Which command: the default page check, launch or brief. */
  command: CliCommand;
  /** gaugeline brief: what to write and where. Absent for every other command. */
  brief?: BriefFlags;
  /** gaugeline handoff: where to write the report. Absent for every other command. */
  handoff?: HandoffFlags;
  /** gaugeline audit --pack: what to write and where. Absent for every other command. */
  audit?: AuditFlags;
  /** launch --dns: add the email record checks. handoff --dns: read the name servers from DNS. */
  dns: boolean;
  /** --renewals (or the renewals command): add the renewals checks (domain, certificates, tokens, runtimes). */
  renewals: boolean;
  /** --cost (or the cost command): add the cost checks (pages that rebuild on every visit, never-cached pages, usage jumps). */
  cost: boolean;
  /** --trackers: add the tracker checks (trackers on pages with a form or a listed sensitive path, and what a Tag Manager container holds). */
  trackers: boolean;
  /** --libraries: add the library check (JavaScript libraries the page loads, with the published advisories that name their version). */
  libraries: boolean;
  /** --wordpress: add the WordPress checks (versions shown against wordpress.org's current releases, and the REST API's list of users). */
  wordpress: boolean;
  /** --backups (or the backups command): add the backups checks (no recent backup, backups not enabled, an export far smaller than the last). */
  backups: boolean;
  /** --published: add the published-not-live checks (changed CMS items against their live pages, and pages of items that are gone). */
  published: boolean;
  /** --owner-consent: run the probing checks (they ask gated routes for what they protect, with no login). */
  ownerConsent: boolean;
  /** --routes: globs over the repository's route files, for the download route probe. */
  routes: string[];
  /** --allow-secret-key: use a Stripe secret key (with a notice) instead of refusing it. */
  allowSecretKey: boolean;
  /** --since last: compare with the stored last run and replace it. */
  since?: "last";
  /** -i, --interactive: open the terminal view after the run. */
  interactive: boolean;
  /** Channel addresses given as flags (the environment can supply them too). */
  notify: { slack?: string; discord?: string; webhook?: string; email?: string };
  notifyOn: "any" | "high" | "always";
  reportUrl?: string;
  /** --save-requests: where to write the request log and page data (a separate file, never the result). */
  saveRequests?: string;
  ci: boolean;
  json: boolean;
  noOpen: boolean;
  verbose: boolean;
  quiet: boolean;
  allowPrivate: boolean;
}

export type ParsedArgs =
  | { kind: "help"; verbose: boolean; command: CliCommand }
  | { kind: "version"; verbose: boolean }
  | { kind: "view"; file: string; verbose: boolean }
  | {
      kind: "plan";
      file: string;
      planOnly: boolean;
      sheet?: string;
      legacyFrom: string[];
      legacyReview?: string;
      /** "" when given without a file name: the default name is used. */
      annotate?: string;
      force: boolean;
      /** "" when given without a file name: the state file beside the plan. */
      progress?: string;
      /** --watch: the cutover date, YYYY-MM-DD (the 30-day watch). */
      watch?: string;
      /** Where to send the findings the run shows (with --watch, only the new ones). */
      notify: { slack?: string; discord?: string; webhook?: string };
      notifyOn: "any" | "high" | "always";
      all: boolean;
      printed?: string;
      live?: string;
      rank?: string;
      /** --nav: [] for every tab headed Main category, or the tabs named. Absent without --nav. */
      nav?: string[];
      ignore: string[];
      base?: string;
      allowPrivate: boolean;
      verbose: boolean;
      quiet: boolean;
    }
  | {
      kind: "printed";
      file: string;
      /** Images (or folders) to read QR codes from: --decode values and the positionals after the file. */
      decode: string[];
      tags?: string[];
      allowPrivate: boolean;
      verbose: boolean;
      quiet: boolean;
    }
  | {
      kind: "snapshot";
      domain: string;
      out: string;
      allowPrivate: boolean;
      verbose: boolean;
      quiet: boolean;
    }
  | { kind: "cutover"; before: string; allowPrivate: boolean; verbose: boolean; quiet: boolean }
  | {
      kind: "advisory";
      /** The client's site, https unless it was typed with http. */
      address: string;
      /** An advisory id (CVE-..., GHSA-...) or a package and range (next@>=15.0.0 <15.2.3). */
      spec: string;
      /** --package: packages and ranges given directly. */
      packages: string[];
      /** --host: other hostnames to look at. */
      hosts: string[];
      dns: boolean;
      note: boolean;
      json: boolean;
      ci: boolean;
      allowPrivate: boolean;
      verbose: boolean;
      quiet: boolean;
    }
  | {
      kind: "migration";
      /** The new site's address, https unless it was typed with http. */
      address: string;
      /** --old: the old site's address, to read its list and its pages. */
      old?: string;
      /** --old-file: an export listing the old site's pages. */
      oldFile?: string;
      ci: boolean;
      allowPrivate: boolean;
      verbose: boolean;
      quiet: boolean;
    }
  | {
      kind: "open";
      address?: string;
      noOpen: boolean;
      /** gaugeline open --demo: example results, no fetcher, no address. */
      demo: boolean;
      /** gaugeline open --ads <file>: the export to read, from the command line only. */
      ads?: string;
      verbose: boolean;
      quiet: boolean;
    }
  | {
      kind: "run-all";
      all: boolean;
      sites: string[];
      tag?: string;
      parallel: number;
      allowPrivate: boolean;
      /** --renewals: each site's run also checks what lapses. */
      renewals: boolean;
      /** --cost: each site's run also checks what runs up the hosting bill. */
      cost: boolean;
      /** --trackers: each site's run also lists the trackers on pages with a form. */
      trackers: boolean;
      /** --libraries: each site's run also checks the JavaScript libraries it serves. */
      libraries: boolean;
      /** --wordpress: each site's run also runs the WordPress checks. */
      wordpress: boolean;
      /** --backups: each site's run also reads when its content and database were last backed up. */
      backups: boolean;
      /** --published: each site's run also compares changed CMS items with their pages. */
      published: boolean;
      verbose: boolean;
      quiet: boolean;
    }
  | {
      kind: "verify";
      file: string;
      limit: number;
      ci: boolean;
      allowPrivate: boolean;
      verbose: boolean;
      quiet: boolean;
    }
  | {
      kind: "ads";
      /** gaugeline ads <export.csv>: the Meta or Google Ads export to read. */
      file: string;
      json: boolean;
      ci: boolean;
      allowPrivate: boolean;
      verbose: boolean;
      quiet: boolean;
    }
  | {
      kind: "tags";
      /** gaugeline tags <link>: the ad link to follow, as typed. */
      address: string;
      ci: boolean;
      allowPrivate: boolean;
      verbose: boolean;
      quiet: boolean;
    }
  | {
      kind: "query";
      /** gaugeline query <dir>: the folder to read, as typed. */
      dir: string;
      json: boolean;
      ci: boolean;
      /** --dupes: also read each published document's id, slug and title and report shared ones. */
      dupes: boolean;
      /** --mutations: read the writes in the code and check their shapes against the schema. Nothing is sent. */
      mutations: boolean;
      /** --graphql: check the GraphQL documents against the schema; `endpoint` is the address that followed it. */
      graphql?: { endpoint?: string };
      /** --suggest --type <name>: write a GROQ query from the published documents of that type. */
      suggest?: { type: string };
      /** --page --type <name> --out <folder>: write queries.ts, types.ts and page.tsx for that type into a folder in your project. */
      page?: { type: string; out: string; force: boolean };
      /** --unused: report the fields the queries fetch and no code reads. Reads source only; no request. */
      unused?: boolean;
      /** --save <file>: write today's gaps to a baseline file after the run; `force` replaces a file that exists. */
      save?: { file: string; force: boolean };
      /** --against <file>: list the gaps created since that baseline, and the ones it closed. */
      against?: { file: string };
      /** --totals "type:stated=parts" and --refs "type:path", as typed: content that has to add up. Parsed when the command runs. */
      generated?: { totals: string[]; refs: string[] };
      /** --schema: the schema file for --mutations, --suggest or --page (default ./schema.json), or for --graphql (SDL or introspection JSON). */
      schema?: string;
      /** --allow-private: an endpoint on this computer or a private network may be asked. */
      allowPrivate: boolean;
      verbose: boolean;
      quiet: boolean;
    }
  | {
      kind: "delivery";
      /** --paid: count the orders paid in Stripe. */
      paid: boolean;
      /** --sent: count the emails Resend sent. */
      sent: boolean;
      /** --since, as typed: 7d, 24h or a date. Checked when the command runs, with the clock. */
      since?: string;
      allowSecretKey: boolean;
      json: boolean;
      ci: boolean;
      verbose: boolean;
      quiet: boolean;
    }
  | {
      kind: "platform";
      webhooks: boolean;
      allowSecretKey: boolean;
      json: boolean;
      ci: boolean;
      verbose: boolean;
      quiet: boolean;
    }
  | {
      kind: "emails";
      /** gaugeline emails <dir>: the folder of rendered emails (or one .html file), as typed. */
      dir: string;
      /** --base, as an address: the site the emails link to. Without it nothing is requested. */
      base?: string;
      allowPrivate: boolean;
      json: boolean;
      ci: boolean;
      verbose: boolean;
      quiet: boolean;
    }
  | {
      kind: "assert";
      /** gaugeline assert --list: print the assertions and run none. */
      list: boolean;
      /** gaugeline assert <id>: the one assertion to run. */
      id?: string;
      verbose: boolean;
      quiet: boolean;
    }
  | {
      kind: "digest";
      runs: string;
      timeZone?: string;
      notify: { email?: string; webhook?: string };
      verbose: boolean;
      quiet: boolean;
    }
  | {
      kind: "routes";
      /** gaugeline check <folder> --routes: the folder with the Next.js app directory, as typed. */
      dir: string;
      /** --base, as an address (a bare domain is https). */
      base: string;
      ownerConsent: boolean;
      allowPrivate: boolean;
      json: boolean;
      ci: boolean;
      verbose: boolean;
      quiet: boolean;
    }
  | ({ kind: "run"; address: string; input: string; deprecatedUsed: FlagDef[] } & RunFlags)
  | { kind: "error"; message: string; hint?: string; verbose: boolean };

/** Turn a parseArgs error into one sentence naming the flag, plus a hint. */
export function describeParseError(
  err: unknown,
  flags: readonly FlagDef[] = FLAGS,
  command = COMMAND,
): { message: string; hint: string } {
  const code = (err as { code?: string }).code;
  const text = err instanceof Error ? err.message : String(err);
  const flag = /'(-[^' ]+)/.exec(text)?.[1] ?? "";
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    // A known flag on a command that does not take it: say which commands do.
    if (flag.split("=")[0] === "--save-requests")
      return {
        message: `--save-requests only works with the page check (gaugeline <address>) and gaugeline launch, not with gaugeline ${command}.`,
        hint: "Run it on one address: gaugeline example.com --save-requests requests.json.",
      };
    const near = nearestFlag(flag, flags, command);
    return {
      message: `Unknown option ${flag}.${near ? ` Did you mean --${near}?` : ""}`,
      hint: UNKNOWN_FLAG_HINT,
    };
  }
  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
    return { message: `${flag} needs a value.`, hint: UNKNOWN_FLAG_HINT };
  }
  return {
    message: `${(text.split("\n")[0] ?? text).replace(/\.?$/, ".")}`,
    hint: UNKNOWN_FLAG_HINT,
  };
}

export function parseCliArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
  flags: readonly FlagDef[] = FLAGS,
): ParsedArgs {
  const verbose = argv.includes("--verbose");
  const first = argv[0];
  const command: CliCommand =
    first !== undefined && (SUBCOMMANDS as readonly string[]).includes(first)
      ? (first as CliCommand)
      : COMMAND;
  // "check" is the default command, and may be written out: gaugeline check ./src --routes --base ...
  const given = command === COMMAND ? (argv[0] === "check" ? argv.slice(1) : argv) : argv.slice(1);
  // --annotate, --progress, --nav and --routes take an optional value: alone, or before another
  // flag, the empty one (--routes with no glob reads the folder's routes, see the routes mode below).
  const rest = given.map((a, i) =>
    (a === "--annotate" || a === "--progress" || a === "--nav" || a === "--routes") &&
    (given[i + 1] === undefined || given[i + 1]?.startsWith("-"))
      ? `${a}=`
      : a,
  );
  // No flag takes a secret: a value on the command line lands in shell history and CI logs.
  for (const a of rest) {
    const name = /^--([a-z-]+)(?:=|$)/.exec(a)?.[1];
    const variable = name !== undefined ? SECRET_FLAGS[name] : undefined;
    if (name !== undefined && variable !== undefined)
      return {
        kind: "error",
        message: `--${name}: no option takes a password or token. Set ${variable} in the environment instead.`,
        hint: "Secrets are read only from environment variables and never printed (see docs/plan-check).",
        verbose,
      };
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: [...rest],
      allowPositionals: true,
      strict: true,
      options: toParseArgsOptions(flags, command),
    });
  } catch (err) {
    return { kind: "error", ...describeParseError(err, flags, command), verbose };
  }
  const values = resolveFlags(parsed.values, env, flags);
  const deprecatedUsed = flags.filter((f) => f.deprecated && parsed.values[f.name] !== undefined);
  if (values.quiet === true && values.verbose === true) {
    return { kind: "error", message: "Choose --quiet or --verbose, not both.", verbose: false };
  }
  if (values.help === true) return { kind: "help", verbose, command };
  const notifyOn = values["notify-on"] ?? "any";
  if (notifyOn !== "any" && notifyOn !== "high" && notifyOn !== "always") {
    return {
      kind: "error",
      message: `--notify-on accepts any, high or always, not "${String(notifyOn)}".`,
      hint: UNKNOWN_FLAG_HINT,
      verbose,
    };
  }
  if (command !== "delivery" && values.since !== undefined && values.since !== "last") {
    return {
      kind: "error",
      message: `--since accepts only last in this version, not "${String(values.since)}".`,
      hint: "Use --since last to compare with the previous run of this site.",
      verbose,
    };
  }
  if (values.version === true) return { kind: "version", verbose };
  if (typeof values["save-requests"] === "string" && values["save-requests"].trim() === "") {
    return {
      kind: "error",
      message: "--save-requests needs a file name.",
      hint: "For example: gaugeline example.com --save-requests requests.json.",
      verbose,
    };
  }

  const positionals = parsed.positionals.map((p) => p.trim()).filter((p) => p !== "");
  if (command === "plan") {
    if (positionals.length !== 1)
      return {
        kind: "error",
        message: "gaugeline plan needs one plan file: gaugeline plan sitemap.csv",
        hint: "Export the plan from your spreadsheet as CSV.",
        verbose,
      };
    return {
      kind: "plan",
      file: positionals[0] ?? "",
      planOnly: values["plan-only"] === true,
      ...(typeof values.sheet === "string" ? { sheet: values.sheet } : {}),
      legacyFrom: Array.isArray(values["legacy-from"])
        ? values["legacy-from"]
        : typeof values["legacy-from"] === "string"
          ? [values["legacy-from"]]
          : [],
      ...(typeof values.annotate === "string" ? { annotate: values.annotate } : {}),
      force: values.force === true,
      ...(typeof values.progress === "string" ? { progress: values.progress } : {}),
      ...(typeof values.watch === "string" ? { watch: values.watch } : {}),
      notify: {
        ...(typeof values.slack === "string" ? { slack: values.slack } : {}),
        ...(typeof values.discord === "string" ? { discord: values.discord } : {}),
        ...(typeof values.webhook === "string" ? { webhook: values.webhook } : {}),
      },
      notifyOn,
      all: values.all === true,
      ...(typeof values.printed === "string" ? { printed: values.printed } : {}),
      ...(typeof values.live === "string" ? { live: values.live } : {}),
      ...(typeof values.rank === "string" ? { rank: values.rank } : {}),
      ...(typeof values.nav === "string"
        ? {
            nav: values.nav
              .split(",")
              .map((n) => n.trim())
              .filter((n) => n !== ""),
          }
        : {}),
      ignore: Array.isArray(values.ignore)
        ? values.ignore
        : typeof values.ignore === "string"
          ? [values.ignore]
          : [],
      ...(typeof values.base === "string" ? { base: values.base } : {}),
      allowPrivate: values["allow-private"] === true,
      ...(typeof values["legacy-review"] === "string"
        ? { legacyReview: values["legacy-review"] }
        : {}),
      verbose,
      quiet: values.quiet === true,
    };
  }
  if (command === "printed") {
    const decodeValues = Array.isArray(values.decode)
      ? values.decode
      : typeof values.decode === "string"
        ? [values.decode]
        : [];
    // A shell expands --decode ./flyers/*.png into one value and more positionals: those are images too.
    if (positionals.length === 0 || (decodeValues.length === 0 && positionals.length > 1))
      return {
        kind: "error",
        message: "gaugeline printed needs one register file: gaugeline printed printed.csv",
        hint: "Columns: url, where, printedOn, expectedDestination. Add --decode <images> to read QR codes.",
        verbose,
      };
    const tags =
      typeof values.tags === "string"
        ? values.tags
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t !== "")
        : undefined;
    return {
      kind: "printed",
      file: positionals[0] ?? "",
      decode: [...decodeValues, ...positionals.slice(1)],
      ...(tags && tags.length > 0 ? { tags } : {}),
      allowPrivate: values["allow-private"] === true,
      verbose,
      quiet: values.quiet === true,
    };
  }
  if (command === "snapshot") {
    const domain = (positionals[0] ?? "").trim();
    if (positionals.length !== 1 || !/^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(domain.replace(/\.$/, "")))
      return {
        kind: "error",
        message:
          "gaugeline snapshot needs one domain: gaugeline snapshot example.com --out before.json",
        hint: "Give the bare domain, without https:// or a path.",
        verbose,
      };
    return {
      kind: "snapshot",
      domain,
      out: typeof values.out === "string" && values.out !== "" ? values.out : "before.json",
      allowPrivate: values["allow-private"] === true,
      verbose,
      quiet: values.quiet === true,
    };
  }
  if (command === "open") {
    if (positionals.length > 1)
      return {
        kind: "error",
        message: `gaugeline open takes at most one address, got ${positionals.length}.`,
        hint: "Run gaugeline open on its own, or gaugeline open yoursite.com.",
        verbose,
      };
    // The demo shows example results and checks nothing, so an address has nothing to do there.
    if (values.demo === true && positionals.length > 0)
      return {
        kind: "error",
        message:
          "gaugeline open --demo takes no address: it shows example results and checks nothing.",
        hint: "Run gaugeline open --demo on its own, or gaugeline open yoursite.com to check a real page.",
        verbose,
      };
    const ads = values.ads;
    if (ads !== undefined && (typeof ads !== "string" || ads.trim() === ""))
      return {
        kind: "error",
        message: "--ads needs the ads export file: gaugeline open --ads ads-export.csv.",
        hint: "Export your ads from Meta Ads Manager or Google Ads as CSV and keep the link and amount-spent columns.",
        verbose,
      };
    // Two ways to fill the app that cannot both be: the demo shows example results about invented
    // sites, and an export is the person's own file.
    if (ads !== undefined && values.demo === true)
      return {
        kind: "error",
        message:
          "gaugeline open --demo and --ads cannot be used together: the demo shows example results, and --ads shows your own export.",
        hint: "Run gaugeline open --demo on its own, or gaugeline open --ads ads-export.csv.",
        verbose,
      };
    if (ads !== undefined && positionals.length > 0)
      return {
        kind: "error",
        message:
          "gaugeline open --ads takes no address: it shows the landing pages in the export, and checks nothing else.",
        hint: "Run gaugeline open --ads ads-export.csv on its own, or gaugeline open yoursite.com to check one page.",
        verbose,
      };
    return {
      kind: "open",
      ...(positionals[0] ? { address: positionals[0] } : {}),
      noOpen: values["no-open"] === true,
      demo: values.demo === true,
      ...(typeof ads === "string" ? { ads } : {}),
      verbose,
      quiet: values.quiet === true,
    };
  }
  if (command === "run") {
    const names = Array.isArray(values.site)
      ? values.site
      : typeof values.site === "string"
        ? [values.site]
        : [];
    const tag = typeof values.tag === "string" ? values.tag : undefined;
    const all = values.all === true;
    if (
      (all ? 1 : 0) + (names.length > 0 ? 1 : 0) + (tag !== undefined ? 1 : 0) !== 1 ||
      positionals.length > 0
    )
      return {
        kind: "error",
        message: "gaugeline run needs one of --all, --site <name> or --tag <tag>.",
        hint: "The sites are listed in gaugeline.sites.json, in the folder you run from.",
        verbose,
      };
    const p = typeof values.parallel === "string" ? values.parallel.trim() : "1";
    if (!/^[1-9]\d*$/.test(p))
      return {
        kind: "error",
        message: `--parallel takes a number of sites at once, 1 or more, not "${p}".`,
        hint: UNKNOWN_FLAG_HINT,
        verbose,
      };
    return {
      kind: "run-all",
      all,
      sites: names,
      ...(tag !== undefined ? { tag } : {}),
      parallel: Number(p),
      allowPrivate: values["allow-private"] === true,
      renewals: values.renewals === true,
      cost: values.cost === true,
      trackers: values.trackers === true,
      libraries: values.libraries === true,
      wordpress: values.wordpress === true,
      backups: values.backups === true,
      published: values.published === true,
      verbose,
      quiet: values.quiet === true,
    };
  }
  if (command === "verify") {
    if (positionals.length !== 1)
      return {
        kind: "error",
        message: "gaugeline verify needs one crawler export: gaugeline verify crawl-export.csv",
        hint: "Export the audit's URLs as CSV from your crawler (an Address or URL column).",
        verbose,
      };
    const limitText = typeof values.limit === "string" ? values.limit.trim() : "40";
    if (!/^\d+$/.test(limitText))
      return {
        kind: "error",
        message: `--limit takes a whole number of pages, not "${limitText}".`,
        hint: "For example --limit 40, or --limit 0 to classify the rows only.",
        verbose,
      };
    return {
      kind: "verify",
      file: positionals[0] ?? "",
      limit: Number(limitText),
      ci: values.ci === true,
      allowPrivate: values["allow-private"] === true,
      verbose,
      quiet: values.quiet === true,
    };
  }
  if (command === "tags") {
    if (positionals.length !== 1)
      return {
        kind: "error",
        message: "gaugeline tags needs one link: gaugeline tags 'shop.example/go?utm_source=x'",
        hint: "Paste the link an ad sends people to, in quotes if it has a ? or & in it.",
        verbose,
      };
    return {
      kind: "tags",
      address: positionals[0] ?? "",
      ci: values.ci === true,
      allowPrivate: values["allow-private"] === true,
      verbose,
      quiet: values.quiet === true,
    };
  }
  if (command === "ads") {
    if (positionals.length !== 1)
      return {
        kind: "error",
        message: "gaugeline ads needs one ads export: gaugeline ads ads-export.csv",
        hint: "Export your ads from Meta Ads Manager or Google Ads as CSV and keep the link and amount-spent columns.",
        verbose,
      };
    return {
      kind: "ads",
      file: positionals[0] ?? "",
      json: values.json === true,
      ci: values.ci === true,
      allowPrivate: values["allow-private"] === true,
      verbose,
      quiet: values.quiet === true,
    };
  }
  if (command === "query") {
    const graphql = values.graphql === true;
    const suggest = values.suggest === true;
    const page = values.page === true;
    const unused = values.unused === true;
    const totals = Array.isArray(values.totals) ? values.totals.map(String) : [];
    const refs = Array.isArray(values.refs) ? values.refs.map(String) : [];
    const generated = totals.length + refs.length > 0;
    const save = typeof values.save === "string";
    const against = typeof values.against === "string";
    if (save && against)
      return {
        kind: "error",
        message: "--save and --against cannot be used together.",
        hint: "Save the baseline in one run (gaugeline query ./src --save before.json), make the change, then compare in another (gaugeline query ./src --against before.json).",
        verbose,
      };
    if (save || against) {
      const flag = save ? "--save" : "--against";
      const file = String(save ? values.save : values.against).trim();
      if (file === "")
        return {
          kind: "error",
          message: `${flag} needs the name of a file: gaugeline query ./src ${flag} before.json`,
          hint: "The file holds check ids, type names, field names and file paths, and is made by --save.",
          verbose,
        };
      const others = [
        ["--graphql", graphql],
        ["--suggest", suggest],
        ["--page", page],
        ["--unused", unused],
        ["--dupes", values.dupes === true],
        ["--json", values.json === true],
        ["--totals", totals.length > 0],
        ["--refs", refs.length > 0],
      ]
        .filter(([, given]) => given === true)
        .map(([name]) => String(name));
      if (others.length > 0)
        return {
          kind: "error",
          message: `${flag} works on the plain query run (with --mutations): it cannot be combined with ${others.join(", ")}.`,
          hint: "A baseline keeps the gaps your code has against your content, so a later run can show only the new ones. Run the others separately.",
          verbose,
        };
      if (against && values.force === true)
        return {
          kind: "error",
          message: "--force is for --page and --save: --against only reads the file.",
          hint: "--force lets --save replace a baseline that already exists.",
          verbose,
        };
    }
    if (
      generated &&
      (suggest || page || unused || graphql || values.dupes === true || values.mutations === true)
    )
      return {
        kind: "error",
        message:
          "--totals and --refs are their own run: they cannot be combined with --suggest, --page, --unused, --graphql, --dupes or --mutations.",
        hint: 'They ask the dataset one question for each rule and print findings. Run the others separately: gaugeline query ./src, then gaugeline query ./src --refs "mealPlan:meals".',
        verbose,
      };
    if (typeof values.out === "string" && !page)
      return {
        kind: "error",
        message:
          "--out is for --page: gaugeline query --page --type resource --out ./src/app/resource/[slug]",
        hint: "--page writes three files into the folder --out names; --force lets it replace files that are already there.",
        verbose,
      };
    if (values.force === true && !page && !save)
      return {
        kind: "error",
        message:
          "--force is for --page and --save: gaugeline query --page --type resource --out ./src/app/resource/[slug]",
        hint: "--page and --save write files; --force lets them replace a file that is already there.",
        verbose,
      };
    if (typeof values.type === "string" && !suggest && !page)
      return {
        kind: "error",
        message:
          "--type is for --suggest and --page: gaugeline query ./src --suggest --type resource",
        hint: "--type names the document type whose published documents the query or the route is written from.",
        verbose,
      };
    if (page) {
      const type = typeof values.type === "string" ? values.type.trim() : "";
      const out = typeof values.out === "string" ? values.out : "";
      const usage = 'gaugeline query --page --type resource --out "./src/app/resource/[slug]"';
      if (type === "" || out.trim() === "")
        return {
          kind: "error",
          message: `gaugeline query --page needs a document type and a folder: ${usage}`,
          hint: "--type names the document type, as it is in your Studio schema; --out names the folder the three files are written into, inside this one.",
          verbose,
        };
      if (positionals.length > 0)
        return {
          kind: "error",
          message: `gaugeline query --page takes no folder to read: it writes where --out says. ${usage}`,
          hint: "Run it from the root of your project; --out is relative to where you run it.",
          verbose,
        };
      if (
        suggest ||
        unused ||
        graphql ||
        values.dupes === true ||
        values.mutations === true ||
        values.json === true
      )
        return {
          kind: "error",
          message:
            "--page is its own run: it cannot be combined with --suggest, --unused, --graphql, --dupes, --mutations or --json.",
          hint: "It writes files and prints the paths it wrote. Run the other checks separately.",
          verbose,
        };
      return {
        kind: "query",
        dir: "",
        json: false,
        ci: values.ci === true,
        dupes: false,
        mutations: false,
        page: { type, out, force: values.force === true },
        ...(typeof values.schema === "string" ? { schema: values.schema } : {}),
        allowPrivate: values["allow-private"] === true,
        verbose,
        quiet: values.quiet === true,
      };
    }
    if (suggest) {
      const type = typeof values.type === "string" ? values.type.trim() : "";
      if (type === "")
        return {
          kind: "error",
          message: "gaugeline query --suggest needs a document type: --suggest --type resource",
          hint: "--type names the document type to write a query for, as it is in your Studio schema (for example resource, post or product).",
          verbose,
        };
      if (positionals.length !== 1)
        return {
          kind: "error",
          message:
            "gaugeline query needs one folder: gaugeline query ./src --suggest --type resource",
          hint: "Give the folder of your site's source, as for the other query checks.",
          verbose,
        };
      if (
        unused ||
        graphql ||
        values.dupes === true ||
        values.mutations === true ||
        values.json === true
      )
        return {
          kind: "error",
          message:
            "--suggest is its own run: it cannot be combined with --unused, --graphql, --dupes, --mutations or --json.",
          hint: "It prints a query as text. Run the other checks separately: gaugeline query ./src, then gaugeline query ./src --suggest --type resource.",
          verbose,
        };
      return {
        kind: "query",
        dir: positionals[0] ?? "",
        json: false,
        ci: values.ci === true,
        dupes: false,
        mutations: false,
        suggest: { type },
        ...(typeof values.schema === "string" ? { schema: values.schema } : {}),
        allowPrivate: values["allow-private"] === true,
        verbose,
        quiet: values.quiet === true,
      };
    }
    if (generated) {
      if (positionals.length !== 1)
        return {
          kind: "error",
          message:
            'gaugeline query needs one folder: gaugeline query ./src --refs "mealPlan:meals"',
          hint: "Give the folder of your site's source, as for the other query checks.",
          verbose,
        };
      if (typeof values.schema === "string")
        return {
          kind: "error",
          message: "--totals and --refs take no --schema: they ask the dataset and read no file.",
          hint: "--schema is for --mutations, --suggest, --page and --graphql.",
          verbose,
        };
      return {
        kind: "query",
        dir: positionals[0] ?? "",
        json: values.json === true,
        ci: values.ci === true,
        dupes: false,
        mutations: false,
        generated: { totals, refs },
        allowPrivate: values["allow-private"] === true,
        verbose,
        quiet: values.quiet === true,
      };
    }
    if (unused) {
      if (positionals.length !== 1)
        return {
          kind: "error",
          message: "gaugeline query needs one folder: gaugeline query ./src --unused",
          hint: "Give the folder of your site's source, as for the other query checks.",
          verbose,
        };
      if (graphql || values.dupes === true || values.mutations === true)
        return {
          kind: "error",
          message:
            "--unused is its own run: it cannot be combined with --graphql, --dupes or --mutations.",
          hint: "It reads your source for both GROQ and GraphQL and asks nothing. Run the others separately: gaugeline query ./src, then gaugeline query ./src --unused.",
          verbose,
        };
      if (typeof values.schema === "string")
        return {
          kind: "error",
          message: "--unused takes no --schema: it reads your source files and nothing else.",
          hint: "--schema is for --mutations and --graphql.",
          verbose,
        };
      return {
        kind: "query",
        dir: positionals[0] ?? "",
        json: values.json === true,
        ci: values.ci === true,
        dupes: false,
        mutations: false,
        unused: true,
        allowPrivate: values["allow-private"] === true,
        verbose,
        quiet: values.quiet === true,
      };
    }
    if (positionals.length !== 1 && !(graphql && positionals.length === 2))
      return {
        kind: "error",
        message: "gaugeline query needs one folder: gaugeline query ./src",
        hint: "Give the folder that holds your source files. It reads GROQ from them; with SANITY_PROJECT_ID set it also counts the documents in your dataset. With --graphql an endpoint address may follow.",
        verbose,
      };
    const endpoint = positionals[1];
    if (endpoint !== undefined && !/^https?:\/\//i.test(endpoint))
      return {
        kind: "error",
        message: `${endpoint} is not an endpoint address: gaugeline query ./src --graphql https://example.com/graphql`,
        hint: "An endpoint starts with https:// (or http://). Leave it out to ask Sanity's GraphQL API for your project, or use --schema <file>.",
        verbose,
      };
    if (graphql && (values.dupes === true || values.mutations === true))
      return {
        kind: "error",
        message: "--graphql is its own run: it cannot be combined with --dupes or --mutations.",
        hint: "Run them one at a time: gaugeline query ./src --graphql, then gaugeline query ./src --mutations.",
        verbose,
      };
    if (graphql && endpoint !== undefined && typeof values.schema === "string")
      return {
        kind: "error",
        message: "--graphql takes an endpoint or --schema <file>, not both.",
        hint: "--schema reads the schema from a file and asks no endpoint. Leave the address out.",
        verbose,
      };
    if (typeof values.schema === "string" && values.mutations !== true && !graphql)
      return {
        kind: "error",
        message:
          "--schema is for --mutations or --graphql: gaugeline query ./src --mutations --schema ./schema.json",
        hint: "--schema names the file that `sanity schema extract` wrote for the mutation checks, or a GraphQL schema (SDL or introspection JSON) for --graphql.",
        verbose,
      };
    return {
      kind: "query",
      dir: positionals[0] ?? "",
      json: values.json === true,
      ci: values.ci === true,
      dupes: values.dupes === true,
      mutations: values.mutations === true,
      ...(graphql ? { graphql: endpoint === undefined ? {} : { endpoint } } : {}),
      ...(save ? { save: { file: String(values.save).trim(), force: values.force === true } } : {}),
      ...(against ? { against: { file: String(values.against).trim() } } : {}),
      ...(typeof values.schema === "string" ? { schema: values.schema } : {}),
      allowPrivate: values["allow-private"] === true,
      verbose,
      quiet: values.quiet === true,
    };
  }
  if (command === "delivery") {
    const paid = values.paid === true;
    const sent = values.sent === true;
    if (positionals.length > 0 || (!paid && !sent))
      return {
        kind: "error",
        message:
          positionals.length > 0
            ? "gaugeline delivery takes no address: it reads your Stripe and Resend accounts."
            : "gaugeline delivery needs --paid, --sent or both: gaugeline delivery --paid --sent",
        hint: "Set STRIPE_API_KEY and RESEND_API_KEY in the environment; the steps are in docs/delivery.",
        verbose,
      };
    if (typeof values.since === "string" && values.since.trim() === "")
      return {
        kind: "error",
        message: "--since needs a window such as 7d, 24h or 2026-11-01.",
        hint: "For example: gaugeline delivery --paid --sent --since 7d.",
        verbose,
      };
    return {
      kind: "delivery",
      paid,
      sent,
      ...(typeof values.since === "string" ? { since: values.since } : {}),
      allowSecretKey: values["allow-secret-key"] === true,
      json: values.json === true,
      ci: values.ci === true,
      verbose,
      quiet: values.quiet === true,
    };
  }
  if (command === "emails") {
    if (positionals.length !== 1)
      return {
        kind: "error",
        message:
          positionals.length === 0
            ? "gaugeline emails needs the folder your email export wrote: gaugeline emails ./emails"
            : `Expected one folder, got ${positionals.length}: ${positionals.join(", ")}.`,
        hint: "Export your emails as HTML first; the steps are in docs/guides/emails.",
        verbose,
      };
    let base: string | undefined;
    if (typeof values.base === "string") {
      const parsedBase = parseAddress(values.base.trim());
      if (!parsedBase.ok)
        return {
          kind: "error",
          message: `--base: ${parsedBase.reason}`,
          hint: "Type the site the emails link to, like https://example.com.",
          verbose,
        };
      base = parsedBase.url.href;
    }
    return {
      kind: "emails",
      dir: positionals[0] ?? "",
      ...(base !== undefined ? { base } : {}),
      allowPrivate: values["allow-private"] === true,
      json: values.json === true,
      ci: values.ci === true,
      verbose,
      quiet: values.quiet === true,
    };
  }
  if (command === "platform") {
    if (positionals.length > 0 || values.webhooks !== true)
      return {
        kind: "error",
        message:
          positionals.length > 0
            ? "gaugeline platform takes no address: it reads your Stripe account."
            : "gaugeline platform needs --webhooks: gaugeline platform --webhooks",
        hint: "Set STRIPE_API_KEY in the environment; the steps are in docs/delivery.",
        verbose,
      };
    return {
      kind: "platform",
      webhooks: true,
      allowSecretKey: values["allow-secret-key"] === true,
      json: values.json === true,
      ci: values.ci === true,
      verbose,
      quiet: values.quiet === true,
    };
  }
  if (command === "assert") {
    const list = values.list === true;
    if (
      positionals.length > 1 ||
      (list && positionals.length > 0) ||
      (!list && positionals.length === 0)
    )
      return {
        kind: "error",
        message:
          list || positionals.length > 1
            ? "gaugeline assert takes one assertion id, or --list on its own."
            : "gaugeline assert needs an assertion id: gaugeline assert no-overlapping-bookings",
        hint: "Run gaugeline assert --list to see the assertions in gaugeline.sources.json.",
        verbose,
      };
    return {
      kind: "assert",
      list,
      ...(positionals[0] ? { id: positionals[0] } : {}),
      verbose,
      quiet: values.quiet === true,
    };
  }
  if (command === "cutover") {
    if (typeof values.before !== "string" || values.before === "" || positionals.length > 0)
      return {
        kind: "error",
        message:
          "gaugeline cutover needs the snapshot taken before: gaugeline cutover --before before.json",
        hint: "Take one first with gaugeline snapshot example.com --out before.json.",
        verbose,
      };
    return {
      kind: "cutover",
      before: values.before,
      allowPrivate: values["allow-private"] === true,
      verbose,
      quiet: values.quiet === true,
    };
  }
  if (command === "migration") {
    const problem = (message: string, hint: string): ParsedArgs => ({
      kind: "error",
      message,
      hint,
      verbose,
    });
    if (positionals.length !== 1)
      return problem(
        positionals.length === 0
          ? "gaugeline migration needs the address of the new site: gaugeline migration preview.example.com --old example.com"
          : `gaugeline migration takes one address, got ${positionals.length}: ${positionals.join(", ")}.`,
        "The new site comes first; the old site's list comes from --old (its address) or --old-file (an export).",
      );
    const parsedNew = parseAddress(positionals[0] ?? "");
    if (!parsedNew.ok)
      return problem(
        `The new site's address: ${parsedNew.reason}`,
        "Type the new site's address like preview.example.com or https://example.com.",
      );
    const old = typeof values.old === "string" ? values.old.trim() : undefined;
    const oldFile = typeof values["old-file"] === "string" ? values["old-file"].trim() : undefined;
    if (old === undefined && oldFile === undefined)
      return problem(
        "gaugeline migration needs the old site: --old <address> or --old-file <export>.",
        "For example: gaugeline migration preview.example.com --old example.com",
      );
    if (oldFile === "")
      return problem(
        "--old-file needs the export file: --old-file wix-pages.csv.",
        "Export the old site's pages as CSV or JSON, with a column for each page's address or path.",
      );
    let oldAddress: string | undefined;
    if (old !== undefined) {
      const parsedOld = parseAddress(old);
      if (!parsedOld.ok)
        return problem(
          `--old: ${parsedOld.reason}`,
          "Type the old site's address, like example.com.",
        );
      oldAddress = parsedOld.url.href;
    }
    return {
      kind: "migration",
      address: parsedNew.url.href,
      ...(oldAddress !== undefined ? { old: oldAddress } : {}),
      ...(oldFile !== undefined ? { oldFile } : {}),
      ci: values.ci === true,
      allowPrivate: values["allow-private"] === true,
      verbose,
      quiet: values.quiet === true,
    };
  }
  if (command === "advisory") {
    const problem = (message: string, hint: string): ParsedArgs => ({
      kind: "error",
      message,
      hint,
      verbose,
    });
    const example = 'gaugeline advisory harbourbar.example "next@>=15.0.0 <15.2.3"';
    if (positionals.length !== 2)
      return problem(
        positionals.length < 2
          ? "gaugeline advisory needs the site and the advisory: gaugeline advisory harbourbar.example CVE-2026-1234"
          : `gaugeline advisory takes a site and one advisory, got ${positionals.length} words: ${positionals.join(", ")}.`,
        `The advisory is an id (CVE-..., GHSA-...) or a package and affected versions in quotes: ${example}`,
      );
    const parsedSite = parseAddress(positionals[0] ?? "");
    if (!parsedSite.ok)
      return problem(
        `The site's address: ${parsedSite.reason}`,
        "Type the site like harbourbar.example or https://harbourbar.example.",
      );
    const listed = (v: unknown): string[] =>
      (Array.isArray(v) ? v : typeof v === "string" ? [v] : [])
        .map((x) => String(x).trim())
        .filter((x) => x !== "");
    const packages = listed(values.package);
    const hosts: string[] = [];
    for (const h of listed(values.host)) {
      const name = h
        .replace(/^https?:\/\//i, "")
        .replace(/\/.*$/, "")
        .toLowerCase();
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(name))
        return problem(
          `--host: "${h.slice(0, 60)}" is not a hostname.`,
          "Give a name such as old.harbourbar.example, with no path.",
        );
      hosts.push(name);
    }
    if (hosts.length > 5)
      return problem("--host: at most 5 other hostnames.", "Run again with the others.");
    if (values.note === true && values.json === true)
      return problem(
        "Choose --note or --json, not both.",
        "--note prints the client's note; --json prints the data.",
      );
    return {
      kind: "advisory",
      address: parsedSite.url.href,
      spec: positionals[1] ?? "",
      packages,
      hosts,
      dns: values.dns === true,
      note: values.note === true,
      json: values.json === true,
      ci: values.ci === true,
      allowPrivate: values["allow-private"] === true,
      verbose,
      quiet: values.quiet === true,
    };
  }
  if (command === "digest") {
    const runs = typeof values.runs === "string" ? values.runs.trim() : (positionals[0] ?? "");
    if (runs === "")
      return {
        kind: "error",
        message: "gaugeline digest needs the folder of saved runs: gaugeline digest --runs runs",
        hint: "Save each run with gaugeline <address> --json > runs/<date>.json.",
        verbose,
      };
    return {
      kind: "digest",
      runs,
      ...(typeof values["time-zone"] === "string" ? { timeZone: values["time-zone"] } : {}),
      notify: {
        ...(typeof values.email === "string" ? { email: values.email } : {}),
        ...(typeof values.webhook === "string" ? { webhook: values.webhook } : {}),
      },
      verbose,
      quiet: values.quiet === true,
    };
  }
  if (command === "view") {
    if (positionals.length !== 1)
      return {
        kind: "error",
        message: "gaugeline view needs one saved run: gaugeline view run.json",
        hint: "Save a run with gaugeline <address> --json > run.json.",
        verbose,
      };
    return { kind: "view", file: positionals[0] ?? "", verbose };
  }
  // gaugeline check <folder> --routes --base <address>: --routes with no glob reads the folder's
  // Next.js routes and asks the running site for each signed-in one. With a glob it keeps its
  // earlier meaning (route files for the download probe, run against the address given).
  const routeValues = Array.isArray(values.routes)
    ? values.routes
    : typeof values.routes === "string"
      ? [values.routes]
      : [];
  if (command === COMMAND && routeValues.some((r) => r === "")) {
    if (routeValues.some((r) => r !== ""))
      return {
        kind: "error",
        message:
          "--routes is given both with and without a glob. Use --routes alone to read a folder's routes, or --routes <glob> to find download routes.",
        hint: UNKNOWN_FLAG_HINT,
        verbose,
      };
    if (typeof values.base !== "string" || values.base.trim() === "")
      return {
        kind: "error",
        message:
          "gaugeline check <folder> --routes needs the address of the running site to ask: --base https://example.com",
        hint: "For example: gaugeline check ./src --routes --base https://example.com --owner-consent",
        verbose,
      };
    if (positionals.length !== 1)
      return {
        kind: "error",
        message:
          positionals.length === 0
            ? "gaugeline check --routes needs the folder with your Next.js app directory: gaugeline check ./src --routes --base https://example.com"
            : `Expected one folder, got ${positionals.length}: ${positionals.join(", ")}.`,
        hint: "The folder holds app/ (or src/app/): for example ./src or the project folder.",
        verbose,
      };
    const base = parseAddress(values.base.trim());
    if (!base.ok)
      return {
        kind: "error",
        message: `--base: ${base.reason}`,
        hint: "Type the running site's address like https://example.com or http://127.0.0.1:3000.",
        verbose,
      };
    return {
      kind: "routes",
      dir: positionals[0] ?? "",
      base: base.url.href,
      ownerConsent: values["owner-consent"] === true,
      allowPrivate: values["allow-private"] === true,
      json: values.json === true,
      ci: values.ci === true,
      verbose,
      quiet: values.quiet === true,
    };
  }
  if (typeof values.base === "string" && command === COMMAND)
    return {
      kind: "error",
      message: "--base is read by gaugeline plan, and by gaugeline check <folder> --routes.",
      hint: "Add --routes (with no glob) to ask a running site for the routes in a folder.",
      verbose,
    };
  let brief: BriefFlags | undefined;
  if (command === "brief") {
    const problem = (message: string, hint: string): ParsedArgs => ({
      kind: "error",
      message,
      hint,
      verbose,
    });
    if (positionals.length !== 1)
      return problem(
        positionals.length === 0
          ? "gaugeline brief needs the address of the site: gaugeline brief example.com"
          : `gaugeline brief takes one address, got ${positionals.length}: ${positionals.join(", ")}.`,
        'For example: gaugeline brief example.com --business "The Corner Bar" --out work-order.md',
      );
    const business = typeof values.business === "string" ? values.business.trim() : undefined;
    if (business === "" || (business !== undefined && business.length > 120))
      return problem(
        "--business needs the business's name, up to 120 characters.",
        'For example: --business "The Corner Bar".',
      );
    const rate = typeof values.rate === "string" ? values.rate.trim() : undefined;
    if (rate !== undefined && !/^[1-9]\d{0,8}$/.test(rate))
      return problem(
        `--rate takes whole currency units above zero, such as 110, not "${String(values.rate)}".`,
        "It is what an hour costs, in dollars: --rate 110 means $110 an hour. It is used together with --hours-per-point.",
      );
    const hours =
      typeof values["hours-per-point"] === "string" ? values["hours-per-point"].trim() : undefined;
    if (hours !== undefined && (!/^\d{1,3}(?:\.\d{1,2})?$/.test(hours) || Number(hours) <= 0))
      return problem(
        `--hours-per-point takes a number above zero with at most two decimals, such as 1.5, not "${String(values["hours-per-point"])}".`,
        "It is how long one point takes you: take an item you finished, divide the hours it took by its points.",
      );
    const out = typeof values.out === "string" ? values.out.trim() : undefined;
    if (out === "")
      return problem(
        "--out needs the name of the Markdown file to write.",
        "For example: --out work-order.md. Leave it out to print the work order.",
      );
    if (values.force === true && out === undefined)
      return problem(
        "--force is for --out: it lets the work order replace a file that already exists.",
        "For example: gaugeline brief example.com --out work-order.md --force",
      );
    brief = {
      ...(business !== undefined ? { business } : {}),
      ...(rate !== undefined ? { rateMinor: Number(rate) * 10 ** minorExponent("usd") } : {}),
      ...(hours !== undefined ? { hoursPerPoint: Number(hours) } : {}),
      ...(out !== undefined ? { out } : {}),
      force: values.force === true,
    };
  }
  let handoff: HandoffFlags | undefined;
  if (command === "handoff") {
    const problem = (message: string, hint: string): ParsedArgs => ({
      kind: "error",
      message,
      hint,
      verbose,
    });
    if (positionals.length !== 1)
      return problem(
        positionals.length === 0
          ? "gaugeline handoff needs the address of the site: gaugeline handoff example.com"
          : `gaugeline handoff takes one address, got ${positionals.length}: ${positionals.join(", ")}.`,
        "For example: gaugeline handoff marlowe-bar.com --out handoff",
      );
    const out = typeof values.out === "string" ? values.out.trim() : undefined;
    if (out === "")
      return problem(
        "--out needs the name of the folder to write the report into.",
        `For example: --out handoff. Leave it out to write ${HANDOFF_DEFAULT_OUT}.`,
      );
    if (values.force === true && out === undefined && values.json === true)
      return problem(
        "--force is for the report files: it lets them replace files that already exist. With --json and no --out nothing is written.",
        "Add --out <folder>, or leave --json out.",
      );
    handoff = { ...(out !== undefined ? { out } : {}), force: values.force === true };
  }
  let audit: AuditFlags | undefined;
  if (command === "audit") {
    const problem = (message: string, hint: string): ParsedArgs => ({
      kind: "error",
      message,
      hint,
      verbose,
    });
    if (positionals.length !== 1)
      return problem(
        positionals.length === 0
          ? "gaugeline audit needs the address of the site: gaugeline audit example.com --pack"
          : `gaugeline audit takes one address, got ${positionals.length}: ${positionals.join(", ")}.`,
        'For example: gaugeline audit marlowe-bar.com --pack --business "Marlowe Bar" --brand "Harbour Studio"',
      );
    if (values.pack !== true)
      return problem(
        "gaugeline audit needs --pack: it turns a first run on a prospect's site into a proposal.",
        "For example: gaugeline audit marlowe-bar.com --pack",
      );
    const text = (name: string, max: number, example: string): string | ParsedArgs | undefined => {
      const v = values[name];
      if (v === undefined) return undefined;
      const t = typeof v === "string" ? v.trim() : "";
      return t === "" || t.length > max
        ? problem(`--${name} needs some text, up to ${max} characters.`, `For example: ${example}`)
        : t;
    };
    const business = text("business", 120, '--business "Marlowe Bar"');
    const name = text("brand", 80, '--brand "Harbour Studio"');
    const contact = text("brand-contact", 200, '--brand-contact "Mia, 555 0142"');
    const logo = text("brand-logo", 300, "--brand-logo https://harbour-studio.example/logo.png");
    for (const v of [business, name, contact, logo]) if (typeof v === "object") return v;
    const logoUrl = typeof logo === "string" ? safeLogoUrl(logo) : undefined;
    if (typeof logo === "string" && logoUrl === undefined)
      return problem(
        `--brand-logo takes an https address with no user name or password, not "${logo}".`,
        "For example: --brand-logo https://harbour-studio.example/logo.png. Gaugeline never fetches it; the browser that opens the pack does.",
      );
    const out = typeof values.out === "string" ? values.out.trim() : AUDIT_DEFAULT_OUT;
    if (out === "")
      return problem(
        "--out needs the name of the folder to write the pack into.",
        `For example: --out proposal. Leave it out to write ${AUDIT_DEFAULT_OUT}.`,
      );
    audit = {
      ...(typeof business === "string" ? { business } : {}),
      brand: {
        ...(typeof name === "string" ? { name } : {}),
        ...(logoUrl !== undefined ? { logoUrl } : {}),
        ...(typeof contact === "string" ? { contact } : {}),
      },
      out,
      force: values.force === true,
    };
  }
  if (positionals.length === 0) {
    return { kind: "error", message: "No address given.", hint: USAGE_HINT, verbose };
  }
  if (positionals.length > 1) {
    return {
      kind: "error",
      message: `Expected one address, got ${positionals.length}: ${positionals.join(", ")}.`,
      hint: USAGE_HINT,
      verbose,
    };
  }
  const input = positionals[0] ?? "";
  const address = parseAddress(input);
  if (!address.ok) {
    return {
      kind: "error",
      message: address.reason,
      hint: "Type an address like example.com or https://example.com/.",
      verbose,
    };
  }
  return {
    kind: "run",
    command,
    ...(brief ? { brief } : {}),
    ...(handoff ? { handoff } : {}),
    ...(audit ? { audit } : {}),
    dns: values.dns === true,
    renewals: values.renewals === true || command === "renewals",
    cost: values.cost === true || command === "cost",
    trackers: values.trackers === true,
    libraries: values.libraries === true,
    wordpress: values.wordpress === true,
    backups: values.backups === true || command === "backups",
    published: values.published === true,
    ownerConsent: values["owner-consent"] === true,
    routes: Array.isArray(values.routes)
      ? values.routes
      : typeof values.routes === "string"
        ? [values.routes]
        : [],
    allowSecretKey: values["allow-secret-key"] === true,
    interactive: values.interactive === true,
    notify: {
      ...(typeof values.slack === "string" ? { slack: values.slack } : {}),
      ...(typeof values.discord === "string" ? { discord: values.discord } : {}),
      ...(typeof values.webhook === "string" ? { webhook: values.webhook } : {}),
      ...(typeof values.email === "string" ? { email: values.email } : {}),
    },
    notifyOn,
    ...(typeof values["report-url"] === "string" ? { reportUrl: values["report-url"] } : {}),
    ...(values.since === "last" ? { since: "last" as const } : {}),
    ...(typeof values["save-requests"] === "string"
      ? { saveRequests: values["save-requests"] }
      : {}),
    address: address.url.href,
    input,
    deprecatedUsed,
    verbose,
    quiet: values.quiet === true,
    allowPrivate: values["allow-private"] === true,
    ci: values.ci === true,
    json: values.json === true,
    noOpen: values["no-open"] === true,
  };
}
