import { FLAGS, renderHelp } from "./flags.js";

/** Every command the CLI registers. "" is the root command (gaugeline <address>). */
export const COMMANDS = ["", "launch", "view", "digest", "plan"] as const;
export type Command = (typeof COMMANDS)[number];

/**
 * Help text, keyed by command. The CLI prints HELP[command] for --help; help text lives here and
 * nowhere else. docs/options.md shows the same text under "Usage", and a test compares the two.
 */
export const HELP: Record<string, string> = {
  "": renderHelp(FLAGS, "check", {
    usage: "gaugeline <address> [options]",
    summary: "Check a website the way search engines and visitors see it. Read-only.",
    footer: "Exit codes: 0 ran, 1 --ci with a fix-first finding, 2 could not run",
  }),
  launch: renderHelp(FLAGS, "launch", {
    usage: "gaugeline launch <address> [options]",
    summary: [
      "Run the launch-day checks: links to preview addresses, the share picture, an",
      "indexable staging site, noindex and robots.txt. Read-only.",
    ].join("\n"),
    footer: "Exit codes: 0 ran, 1 --ci with a fix-first finding, 2 could not run",
  }),
  view: renderHelp(FLAGS, "view", {
    usage: "gaugeline view <run.json> [options]",
    summary: [
      "Open a saved run (gaugeline <address> --json > run.json) in a terminal view.",
      "Keys: j/k move, enter expand, / filter, d dismiss with a reason, q quit.",
    ].join("\n"),
    footer: "Exit codes: 0 viewed, 2 the file could not be read",
  }),
  plan: renderHelp(FLAGS, "plan", {
    usage: "gaugeline plan <file> [options]",
    summary: [
      "Read a launch plan: any CSV with a URL column. Title tag, H1, keyword and",
      "legacy URL columns are used when present; names are matched loosely.",
    ].join("\n"),
    footer: "Exit codes: 0 read, 2 the plan could not be read",
  }),
  digest: renderHelp(FLAGS, "digest", {
    usage: "gaugeline digest --runs <folder> [options]",
    summary: [
      "Read a week of saved runs and write what is new, fixed and still open, in plain",
      "English, to gaugeline-digest.md and gaugeline-digest.html. Sends only by email",
      "or webhook, and only when one is configured.",
    ].join("\n"),
    footer: "Exit codes: 0 written, 2 the runs could not be read",
  }),
};
