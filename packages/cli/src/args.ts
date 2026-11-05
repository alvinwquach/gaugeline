import { parseArgs } from "node:util";
import { parseAddress } from "@gaugeline/core";

export const USAGE_LINE = "gaugeline <address> [options]";

export interface RunFlags {
  ci: boolean;
  json: boolean;
  noOpen: boolean;
  verbose: boolean;
  quiet: boolean;
}

export const USAGE = `Usage: ${USAGE_LINE}

Check a website the way search engines and visitors see it. Read-only.

Options:
      --ci         Exit 1 when a "Fix this first" finding is found (also when CI is set)
      --json       Print the result as JSON on stdout, and nothing else
      --no-open    Do not open anything in a browser
      --quiet      Print only results and errors
      --verbose    Show each request and technical detail when something goes wrong
  -h, --help       Show this help and exit
  -v, --version    Print the version and exit

Exit codes: 0 ran, 1 --ci with a fix-first finding, 2 could not run`;

export const USAGE_HINT = `${USAGE_LINE}, for example: gaugeline example.com (see gaugeline --help)`;

export type ParsedArgs =
  | { kind: "help"; verbose: boolean }
  | { kind: "version"; verbose: boolean }
  | ({ kind: "run"; address: string; input: string } & RunFlags)
  | { kind: "error"; message: string; hint?: string; verbose: boolean };

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // parseArgs names the flag: "Unknown option '--frobnicate'..."
    const firstLine = err.message.split("\n")[0] ?? err.message;
    return firstLine.replace(/\. To specify a positional argument.*$/, "").replace(/\.?$/, ".");
  }
  return String(err);
}

export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  const verbose = argv.includes("--verbose");
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        verbose: { type: "boolean" },
        quiet: { type: "boolean" },
        ci: { type: "boolean" },
        json: { type: "boolean" },
        "no-open": { type: "boolean" },
      },
    });
  } catch (err) {
    return { kind: "error", message: errorMessage(err), hint: USAGE_HINT, verbose };
  }
  if (parsed.values.quiet === true && parsed.values.verbose === true) {
    return { kind: "error", message: "Choose --quiet or --verbose, not both.", verbose: false };
  }
  if (parsed.values.help === true) return { kind: "help", verbose };
  if (parsed.values.version === true) return { kind: "version", verbose };

  const positionals = parsed.positionals.map((p) => p.trim()).filter((p) => p !== "");
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
    address: address.url.href,
    input,
    verbose,
    quiet: parsed.values.quiet === true,
    ci: parsed.values.ci === true,
    json: parsed.values.json === true,
    noOpen: parsed.values["no-open"] === true,
  };
}
