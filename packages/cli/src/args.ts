import { parseArgs } from "node:util";
import { parseAddress } from "@gaugeline/core";

export const USAGE = `Usage: gaugeline <address> [options]

Check a website the way search engines and visitors see it. Read-only.

Options:
  -h, --help       Show this help and exit
  -v, --version    Print the version and exit

Exit codes: 0 ran, 1 --ci with a fix-first finding, 2 could not run`;

export type ParsedArgs =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "run"; address: string }
  | { kind: "error"; message: string; showUsage: boolean };

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // parseArgs names the flag: "Unknown option '--frobnicate'..."
    const firstLine = err.message.split("\n")[0] ?? err.message;
    return firstLine.replace(/\. To specify a positional argument.*$/, "");
  }
  return String(err);
}

export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    return { kind: "error", message: errorMessage(err), showUsage: true };
  }
  if (parsed.values.help === true) return { kind: "help" };
  if (parsed.values.version === true) return { kind: "version" };

  const positionals = parsed.positionals.map((p) => p.trim()).filter((p) => p !== "");
  if (positionals.length === 0) {
    return { kind: "error", message: "No address given.", showUsage: true };
  }
  if (positionals.length > 1) {
    return {
      kind: "error",
      message: `Expected one address, got ${positionals.length}: ${positionals.join(", ")}`,
      showUsage: true,
    };
  }
  const address = parseAddress(positionals[0] ?? "");
  if (!address.ok) return { kind: "error", message: address.reason, showUsage: false };
  return { kind: "run", address: address.url.href };
}
