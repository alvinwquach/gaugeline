import { parseArgs } from "node:util";
import { parseAddress } from "@gaugeline/core";
import {
  FLAGS,
  nearestFlag,
  renderHelp,
  resolveFlags,
  toParseArgsOptions,
  type FlagDef,
} from "./flags.js";

export const USAGE_LINE = "gaugeline <address> [options]";
export const COMMAND = "check";

export const USAGE = renderHelp(FLAGS, COMMAND, {
  usage: USAGE_LINE,
  summary: "Check a website the way search engines and visitors see it. Read-only.",
  footer: "Exit codes: 0 ran, 1 --ci with a fix-first finding, 2 could not run",
});

export const USAGE_HINT = `${USAGE_LINE}, for example: gaugeline example.com (see gaugeline --help)`;
export const UNKNOWN_FLAG_HINT = "Run gaugeline --help to see every option.";

export interface RunFlags {
  ci: boolean;
  json: boolean;
  noOpen: boolean;
  verbose: boolean;
  quiet: boolean;
  allowPrivate: boolean;
}

export type ParsedArgs =
  | { kind: "help"; verbose: boolean }
  | { kind: "version"; verbose: boolean }
  | ({ kind: "run"; address: string; input: string } & RunFlags)
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
): ParsedArgs {
  const verbose = argv.includes("--verbose");
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: toParseArgsOptions(FLAGS, COMMAND),
    });
  } catch (err) {
    return { kind: "error", ...describeParseError(err), verbose };
  }
  const values = resolveFlags(parsed.values, env, FLAGS);
  if (values.quiet === true && values.verbose === true) {
    return { kind: "error", message: "Choose --quiet or --verbose, not both.", verbose: false };
  }
  if (values.help === true) return { kind: "help", verbose };
  if (values.version === true) return { kind: "version", verbose };

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
    quiet: values.quiet === true,
    allowPrivate: values["allow-private"] === true,
    ci: values.ci === true,
    json: values.json === true,
    noOpen: values["no-open"] === true,
  };
}
