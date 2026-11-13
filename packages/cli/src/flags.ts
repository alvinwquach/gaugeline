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
  /** Where a command needs different words than the table has, by command name (help only). */
  commandDescriptions?: Readonly<Record<string, string>>;
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

export const FLAGS: readonly FlagDef[] = Object.freeze<FlagDef[]>([
  {
    name: "ci",
    type: "boolean",
    description: 'Exit 1 when a "Fix this first" finding is found',
    env: "CI",
    since: "0.1.0",
    commands: [
      "check",
      "launch",
      "renewals",
      "handoff",
      "cost",
      "backups",
      "migration",
      "advisory",
      "verify",
      "tags",
      "ads",
      "delivery",
      "platform",
      "query",
      "emails",
      "source",
    ],
  },
  {
    name: "json",
    type: "boolean",
    description: "Print the result as JSON on stdout, and nothing else",
    since: "0.1.0",
    commands: [
      "check",
      "deploy-gate",
      "launch",
      "renewals",
      "handoff",
      "advisory",
      "cost",
      "backups",
      "ads",
      "delivery",
      "platform",
      "query",
      "emails",
      "changes",
      "receipt",
      "source",
      "receipts",
      "house-rules",
    ],
  },
  {
    name: "format",
    type: "string",
    description:
      "What stdout carries: json (as --json), sarif, junit or one-pager (a cited page; view reads a saved run)",
    since: "0.2.0",
    commands: ["check", "deploy-gate", "launch", "renewals", "cost", "backups", "view"],
  },
  {
    name: "json-schema",
    type: "string",
    description:
      "With --json: the result schema to print, 2 (the default) or 3 (also lists what suppressions and the baseline hide)",
    since: "0.2.0",
    commands: ["check", "launch", "renewals", "cost", "backups"],
  },
  {
    name: "no-open",
    type: "boolean",
    description: "Do not open anything in a browser",
    since: "0.1.0",
    commands: ["check", "launch", "renewals", "cost", "backups", "open"],
  },
  {
    name: "demo",
    type: "boolean",
    description:
      "Start the app with example results about invented sites; no address is checked and nothing is requested",
    since: "0.2.0",
    commands: ["open"],
  },
  {
    name: "ads",
    type: "string",
    description:
      "Start the app with an ads export read from this file (a Meta Ads Manager or Google Ads CSV)",
    since: "0.2.0",
    commands: ["open"],
  },
  {
    name: "allow-private",
    type: "boolean",
    description:
      "Allow addresses on this computer or a private network, such as 127.0.0.1 or 192.168.x.x",
    since: "0.1.0",
    commands: [
      "check",
      "launch",
      "renewals",
      "handoff",
      "cost",
      "backups",
      "brief",
      "audit",
      "migration",
      "advisory",
      "init",
      "deploy-gate",
      "plan",
      "printed",
      "snapshot",
      "cutover",
      "verify",
      "run",
      "ads",
      "tags",
      "query",
      "emails",
      "propose",
    ],
  },
  {
    name: "allow-secret-key",
    type: "boolean",
    description:
      "Use a Stripe secret key, with a notice, instead of refusing it; a restricted key is safer",
    since: "0.2.0",
    commands: ["check", "launch", "brief", "audit", "delivery", "platform"],
  },
  {
    name: "dns",
    type: "boolean",
    description: "Also read the domain's mail records (SPF and DMARC) from DNS",
    since: "0.2.0",
    commands: ["check", "launch", "brief", "audit", "handoff", "advisory", "init", "deploy-gate"],
  },
  {
    name: "renewals",
    type: "boolean",
    description:
      "Also check what lapses: the domain's registration, the certificates and any token you set up",
    since: "0.2.0",
    commands: ["check", "run"],
  },
  {
    name: "cost",
    type: "boolean",
    description:
      "Also check what runs up the hosting bill: pages that change on every visit, the cache and usage jumps",
    since: "0.2.0",
    commands: ["check", "run"],
  },
  {
    name: "trackers",
    type: "boolean",
    description:
      "Also list the trackers on pages with a form or a path you listed, and what a tag manager holds",
    since: "0.2.0",
    commands: ["check", "run"],
  },
  {
    name: "renderer",
    type: "string",
    description:
      "Also load the page in a browser you installed (playwright), to read what scripts add; never downloads one",
    since: "0.2.0",
    commands: ["check"],
  },
  {
    name: "libraries",
    type: "boolean",
    description:
      "Also check the JavaScript files a page loads for libraries with a published advisory",
    since: "0.2.0",
    commands: ["check", "run"],
  },
  {
    name: "wordpress",
    type: "boolean",
    description:
      "Also check a WordPress site's versions against the current releases, and whether it lists its users",
    since: "0.2.0",
    commands: ["check", "run"],
  },
  {
    name: "backups",
    type: "boolean",
    description:
      "Also check when the client's content and database were last backed up (Supabase, Sanity, an export folder)",
    since: "0.2.0",
    commands: ["check", "run"],
  },
  {
    name: "published",
    type: "boolean",
    description:
      "Also check that content changed in your CMS is live on the site, and that unpublished pages are gone",
    since: "0.2.0",
    commands: ["check", "run"],
  },
  {
    name: "owner-consent",
    type: "boolean",
    description:
      "Run the probing checks, which ask routes for what they protect with no login; only on sites you may test",
    since: "0.2.0",
    commands: ["check", "brief", "audit", "deploy-gate"],
  },
  {
    name: "routes",
    type: "string",
    description:
      "With --owner-consent: download routes in files matching this glob (repeatable); no glob: a folder's signed-in routes",
    since: "0.2.0",
    commands: ["check"],
    multiple: true,
  },
  {
    name: "since",
    type: "string",
    description:
      "Page check: compare with the last run (the only value is last). delivery: the window to read, such as 7d",
    commandDescriptions: {
      changes: "Findings that appeared after this date (2026-11-01) or run id (r-20261101T100000Z)",
    },
    since: "0.2.0",
    commands: ["check", "delivery", "changes"],
  },
  {
    name: "before-after",
    type: "boolean",
    description:
      "Print two saved runs side by side: fixed, new and still there (--since names the before run)",
    since: "0.2.0",
    commands: ["changes"],
  },
  {
    name: "coming-up",
    type: "boolean",
    description:
      "Also read what lapses in the next 60 days (domain, certificates, tokens) for Coming up",
    since: "0.2.0",
    commands: ["receipt"],
  },
  {
    name: "month",
    type: "string",
    description: "The month a receipt covers, as yyyy-mm in UTC (default: the last whole month)",
    since: "0.2.0",
    commands: ["receipt"],
  },
  {
    name: "client-reported",
    type: "string",
    description:
      "A fix your client reported first, as a check id with an optional page (payment-link-dead@/visit); repeatable",
    since: "0.2.0",
    commands: ["receipt"],
    multiple: true,
  },
  {
    name: "printable",
    type: "boolean",
    description: "Print the receipt as one page to print or save as a PDF, instead of Markdown",
    since: "0.2.0",
    commands: ["receipt"],
  },
  {
    name: "paid",
    type: "boolean",
    description:
      "Count the orders paid in Stripe in the window; with --sent, compare them with the emails",
    since: "0.2.0",
    commands: ["delivery"],
  },
  {
    name: "sent",
    type: "boolean",
    description:
      "Count the emails Resend says it sent in the window; with --paid, compare them with the orders",
    since: "0.2.0",
    commands: ["delivery"],
  },
  {
    name: "dupes",
    type: "boolean",
    description:
      "With query: name documents that share a slug or a title (reads each one's id, slug and title)",
    since: "0.2.0",
    commands: ["query"],
  },
  {
    name: "mutations",
    type: "boolean",
    description:
      "With query: check the writes in your code against the schema (parsed, never sent)",
    since: "0.2.0",
    commands: ["query"],
  },
  {
    name: "graphql",
    type: "boolean",
    description:
      "With query: check the GraphQL in your code against the schema (an endpoint may follow; Sanity's when none)",
    since: "0.2.0",
    commands: ["query"],
  },
  {
    name: "suggest",
    type: "boolean",
    description:
      "With query: write a GROQ query for a type from the schema and document counts (needs --type)",
    since: "0.2.0",
    commands: ["query"],
  },
  {
    name: "page",
    type: "boolean",
    description:
      "With query: write a route (queries, types, page) from the schema and counts into --out (needs --type)",
    since: "0.2.0",
    commands: ["query"],
  },
  {
    name: "unused",
    type: "boolean",
    description:
      "With query: list fields your queries fetch that no code reads, GROQ and GraphQL (source only, no request)",
    since: "0.2.0",
    commands: ["query"],
  },
  {
    name: "totals",
    type: "string",
    description:
      "With query: check a stated number against the sum of its parts, as type:stated=parts (repeatable)",
    since: "0.2.0",
    commands: ["query"],
    multiple: true,
  },
  {
    name: "refs",
    type: "string",
    description:
      "With query: find documents that link to things nobody published, as type:path (repeatable)",
    since: "0.2.0",
    commands: ["query"],
    multiple: true,
  },
  {
    name: "save",
    type: "string",
    description:
      "With query: save today's gaps (names only) to this file, to compare a later run with",
    since: "0.2.0",
    commands: ["query"],
  },
  {
    name: "against",
    type: "string",
    description:
      "With query: list the gaps created since the --save file, and those it closed; --ci fails on a new high one",
    since: "0.2.0",
    commands: ["query"],
  },
  {
    name: "type",
    type: "string",
    description:
      "With query --suggest or --page: the document type to write the query or the route for, as in your schema",
    since: "0.2.0",
    commands: ["query"],
  },
  {
    name: "schema",
    type: "string",
    description:
      "With query: the schema file (sanity schema extract; SDL or introspection JSON for --graphql)",
    since: "0.2.0",
    commands: ["query"],
  },
  {
    name: "webhooks",
    type: "boolean",
    description: "Read Stripe's webhook endpoints and the events that were never delivered",
    since: "0.2.0",
    commands: ["platform"],
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
    commands: ["check", "launch", "renewals", "cost", "backups", "plan"],
  },
  {
    name: "discord",
    type: "string",
    description: "Send an embed to this Discord webhook (or set GAUGELINE_DISCORD_WEBHOOK)",
    since: "0.2.0",
    commands: ["check", "launch", "renewals", "cost", "backups", "plan"],
  },
  {
    name: "webhook",
    type: "string",
    description: "POST the result as JSON to this address (or set GAUGELINE_WEBHOOK)",
    since: "0.2.0",
    commands: ["check", "launch", "renewals", "cost", "backups", "digest", "plan"],
  },
  {
    name: "email",
    type: "string",
    description: "Email the full report to these addresses through Resend (or set GAUGELINE_EMAIL)",
    since: "0.2.0",
    commands: ["check", "launch", "renewals", "cost", "backups", "digest"],
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
    description:
      "The site a plan is checked against (a preview); the site emails link to; or the site to ask for --routes",
    since: "0.2.0",
    commands: ["plan", "check", "emails", "propose"],
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
    description:
      "Let --annotate (plan), --page, --save (query), --out (brief), handoff or audit replace files, never a folder or link",
    commandDescriptions: {
      evals: "Replace a report that is already there; never a folder or a link",
    },
    since: "0.2.0",
    commands: ["plan", "query", "brief", "handoff", "audit", "init", "evals"],
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
    name: "watch",
    type: "string",
    description: "With --base on production: the 30-day watch from this cutover date (YYYY-MM-DD)",
    since: "0.2.0",
    commands: ["plan"],
  },
  {
    name: "all",
    type: "boolean",
    description:
      "plan --progress: list the findings still open; run: check every site in gaugeline.sites.json",
    since: "0.2.0",
    commands: ["plan", "run"],
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
    name: "nav",
    type: "string",
    description:
      "Check the menu tabs (all headed Main category, or these, comma separated) against the pages",
    since: "0.2.0",
    commands: ["plan"],
  },
  {
    name: "rank",
    type: "string",
    description:
      "With --live, sort the missing pages by clicks from this Search Console or rank export",
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
    name: "site",
    type: "string",
    description: "Check this site from gaugeline.sites.json, by name (repeatable)",
    since: "0.2.0",
    commands: ["run"],
    multiple: true,
  },
  {
    name: "tag",
    type: "string",
    description: "Check the sites in gaugeline.sites.json with this tag, such as client",
    since: "0.2.0",
    commands: ["run"],
  },
  {
    name: "parallel",
    type: "string",
    description: "Check this many sites at once (default 1); sites on one host never overlap",
    since: "0.2.0",
    commands: ["run"],
  },
  {
    name: "limit",
    type: "string",
    description:
      "Re-check this many of the export's pages (default 40; 0 only classifies the rows)",
    since: "0.2.0",
    commands: ["verify"],
  },
  {
    name: "out",
    type: "string",
    description:
      "snapshot: the file (default before.json). query --page: the folder. brief: the file. handoff, audit: the folder",
    commandDescriptions: {
      propose: "The proposals file (default gaugeline.proposals.json)",
      evals:
        "The JSON report's file (default gaugeline-evals.json), in this folder or one inside it",
      mine: "The draft file, Markdown (default field-findings.draft.md)",
      "house-rules":
        "The draft file to write (default gaugeline.rules.draft.json); its name must end in .draft.json and it must not exist yet",
      "write-check": "The draft file, Markdown (default check-writer.draft.md)",
    },
    since: "0.2.0",
    commands: [
      "snapshot",
      "query",
      "brief",
      "handoff",
      "audit",
      "propose",
      "evals",
      "mine",
      "house-rules",
      "write-check",
    ],
  },
  {
    name: "business",
    type: "string",
    description:
      "brief: the business the work order is for, shown in its heading. audit: the prospect's business",
    since: "0.2.0",
    commands: ["brief", "audit"],
  },
  {
    name: "rate",
    type: "string",
    description:
      "brief: what an hour costs, in whole currency units such as 110; used with --hours-per-point",
    since: "0.2.0",
    commands: ["brief"],
  },
  {
    name: "hours-per-point",
    type: "string",
    description:
      "brief: how many hours one point takes, such as 1.5; prints a range of hours, never one number",
    since: "0.2.0",
    commands: ["brief"],
  },
  {
    name: "pack",
    type: "boolean",
    description:
      "audit: turn the run into a proposal-ready pack (HTML and Markdown), using the packages in gaugeline.services.json",
    since: "0.2.0",
    commands: ["audit"],
  },
  {
    name: "brand",
    type: "string",
    description: "audit: your name, shown at the head and foot of the pack",
    since: "0.2.0",
    commands: ["audit"],
  },
  {
    name: "brand-logo",
    type: "string",
    description:
      "audit: an https address for your logo; it is never fetched by Gaugeline, only by whoever opens the pack",
    since: "0.2.0",
    commands: ["audit"],
  },
  {
    name: "brand-contact",
    type: "string",
    description: "audit: your contact line, shown under your name",
    since: "0.2.0",
    commands: ["audit"],
  },
  {
    name: "before",
    type: "string",
    description: "The snapshot taken before cutover, written by gaugeline snapshot",
    since: "0.2.0",
    commands: ["cutover"],
  },
  {
    name: "old",
    type: "string",
    description:
      "migration: the old site's address, to read its list of pages and the pages themselves",
    since: "0.2.0",
    commands: ["migration"],
  },
  {
    name: "old-file",
    type: "string",
    description:
      "migration: a Wix, Webflow or other export (CSV or JSON) that lists the old site's pages, read from this file",
    since: "0.2.0",
    commands: ["migration"],
  },
  {
    name: "package",
    type: "string",
    description:
      "advisory: a package@range to use instead of looking the id up in OSV (repeatable)",
    since: "0.2.0",
    commands: ["advisory"],
    multiple: true,
  },
  {
    name: "host",
    type: "string",
    description:
      "advisory: another hostname of the client to look at, such as an old subdomain (up to 5)",
    since: "0.2.0",
    commands: ["advisory"],
    multiple: true,
  },
  {
    name: "block",
    type: "boolean",
    description:
      'deploy-gate: exit 1 when a "Fix this first" finding is found; without it the gate only reports',
    env: "GAUGELINE_GATE_BLOCK",
    since: "0.2.0",
    commands: ["deploy-gate"],
  },
  {
    name: "only",
    type: "string",
    description:
      "source: run just these checks, by id, separated by commas (an unknown id is refused)",
    since: "0.2.0",
    commands: ["source"],
  },
  {
    name: "agent",
    type: "string",
    description: "evals: run just this agent's eval set, by id (an agent with no set is refused)",
    since: "0.2.0",
    commands: ["evals"],
  },
  {
    name: "rules",
    type: "string",
    description:
      "house-rules: the file of written rules to compile (plain text or Markdown, up to 50,000 characters)",
    since: "0.2.0",
    commands: ["house-rules"],
  },
  {
    name: "head",
    type: "string",
    description:
      "receipts verify: a head hash written down earlier, which the chain must still contain",
    since: "0.2.0",
    commands: ["receipts"],
  },
  {
    name: "review-notes",
    type: "string",
    description:
      "mine: the folder of review notes (Markdown or text) to read; only lines that start with #pattern-name are used",
    since: "0.2.0",
    commands: ["mine"],
  },
  {
    name: "deny-list",
    type: "string",
    description:
      "mine, write-check: client names, one per line, to keep out of the draft (the scrub fails it if one gets in)",
    commandDescriptions: {
      mine: "mine: a file of client names, one per line, that must never reach the draft (the scrub fails it if one does)",
      "write-check":
        "write-check: a file of client names, one per line, that must never reach the draft (the scrub fails it if one does)",
    },
    since: "0.2.0",
    commands: ["mine", "write-check"],
  },
  {
    name: "from-file",
    type: "string",
    description:
      "write-check: the advisory or docs page saved as a local file (JSON or Markdown, up to 64 KB); never fetched",
    since: "0.2.0",
    commands: ["write-check"],
  },
  {
    name: "fixes",
    type: "boolean",
    description:
      "propose: turn fix proposals on (they are off by default); nothing is sent, the diffs are written to a file",
    env: "GAUGELINE_FIXES",
    since: "0.2.0",
    commands: ["propose"],
  },
  {
    name: "repo",
    type: "string",
    description: "propose: the project's folder on this computer (a checkout of its repository)",
    since: "0.2.0",
    commands: ["propose"],
  },
  {
    name: "plan",
    type: "string",
    description:
      "propose: the launch plan (CSV); with --base, each old address that does not redirect gets a proposal",
    since: "0.2.0",
    commands: ["propose"],
  },
  {
    name: "to-inbox",
    type: "string",
    description:
      "propose: also write each proposal as the hosted inbox's pull-request draft (JSON) to this file",
    since: "0.2.0",
    commands: ["propose"],
  },
  {
    name: "repository",
    type: "string",
    description:
      "propose: the repository's name on GitHub (owner/name), written into each proposal; optional",
    since: "0.2.0",
    commands: ["propose"],
  },
  {
    name: "dry-run",
    type: "boolean",
    description: "init: print the settings files it would write, and write nothing",
    since: "0.2.0",
    commands: ["init"],
  },
  {
    name: "note",
    type: "boolean",
    description: "advisory: print the short note for the client (Markdown) instead of the report",
    since: "0.2.0",
    commands: ["advisory"],
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
    commands: ["check", "launch", "renewals", "cost", "backups", "plan"],
  },
  {
    name: "report-url",
    type: "string",
    description: "Link each message to a hosted copy of the report at this address",
    since: "0.2.0",
    commands: ["check", "launch", "renewals", "cost", "backups"],
  },
  {
    name: "upload",
    type: "boolean",
    description:
      "Upload the result to your hosted workspace; needs GAUGELINE_TOKEN and GAUGELINE_UPLOAD_URL (see the API page)",
    since: "0.2.0",
    commands: ["check", "launch"],
  },
  {
    name: "save-requests",
    type: "string",
    description:
      "Save the requests made and the page's data to this JSON file; it may contain page content, so do not commit it",
    since: "0.2.0",
    commands: ["check", "launch", "renewals", "cost", "backups"],
  },
  {
    name: "baseline",
    type: "string",
    description: "Read or write a file of known findings; with it a run reports only new ones",
    since: "0.2.0",
    commands: ["check", "launch"],
  },
  {
    name: "update-baseline",
    type: "boolean",
    description: "With --baseline, write the file again from this run",
    since: "0.2.0",
    commands: ["check", "launch"],
  },
  {
    name: "config-json-only",
    type: "boolean",
    description:
      "Refuse a gaugeline.config.mjs, .js or .ts, which runs code; read gaugeline.config.json only",
    env: "GAUGELINE_NO_EXEC_CONFIG",
    since: "0.2.0",
    commands: ["check", "launch"],
  },
  {
    name: "suppress",
    type: "string",
    description: "Snooze a check id for this run, with an expiry and a reason (repeatable)",
    since: "0.2.0",
    commands: ["check", "launch"],
    multiple: true,
  },
  {
    name: "suppress-until",
    type: "string",
    description: "With --suppress, the last day it applies, YYYY-MM-DD; a past date is refused",
    since: "0.2.0",
    commands: ["check", "launch"],
  },
  {
    name: "suppress-reason",
    type: "string",
    description: "With --suppress, why the finding is accepted for now",
    since: "0.2.0",
    commands: ["check", "launch"],
  },
  {
    name: "list",
    type: "boolean",
    description: "Print the data assertions in gaugeline.sources.json and run none of them",
    since: "0.2.0",
    commands: ["assert"],
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
    const own = f.commandDescriptions?.[command] ?? f.description;
    const desc = f.env ? `${own} [${f.env}]` : own;
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
