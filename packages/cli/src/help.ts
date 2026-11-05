import { FLAGS, renderHelp } from "./flags.js";

/** Every command the CLI registers. "" is the root command (gaugeline <address>). */
export const COMMANDS = [""] as const;
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
};
