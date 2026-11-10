import {
  ConfigError,
  assertionsOf,
  createFetcher,
  databaseEnvVars,
  describeAssertion,
  freezeEnv,
  readAssertions,
  type Outcome,
  type SourcesConfig,
} from "@gaugeline/core";
import { SOURCES_CONFIG_FILE, readSourcesConfig } from "./schema-config.js";

interface Out {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  env?: Record<string, string | undefined>;
}

const pad = (text: string, width: number): string =>
  text + " ".repeat(Math.max(0, width - text.length));

/** The list: one line per assertion, nothing read from any database. */
function list(config: SourcesConfig | undefined, io: Out): void {
  const placed = config ? assertionsOf(config) : [];
  if (placed.length === 0) {
    io.stdout.write(
      `No data assertions are set up. Add an "assertions" list to ${SOURCES_CONFIG_FILE} (see docs/guides/data-assertions).\n`,
    );
    return;
  }
  const idWidth = Math.max(...placed.map((p) => p.assertion.id.length));
  const sourceWidth = Math.max(...placed.map((p) => p.source.length));
  io.stdout.write(
    `${placed.length} data assertion${placed.length === 1 ? "" : "s"} in ${SOURCES_CONFIG_FILE}:\n\n`,
  );
  for (const { assertion, source } of placed)
    io.stdout.write(
      `  ${pad(assertion.id, idWidth)}  ${pad(assertion.severity, 6)}  ${pad(source, sourceWidth)}  ${assertion.title}\n`,
    );
}

/**
 * gaugeline assert --list | <id>. The file is read and every assertion's SQL judged before anything
 * else, so a write in it is exit 2 for either form. `<id>` runs one assertion through the database
 * connector (the same three read-only layers a page check uses) and makes no request of any site.
 */
export async function runAssert(
  args: { list: boolean; id?: string; quiet: boolean },
  io: Out,
  deps: { cwd: string },
): Promise<Outcome> {
  const config = readSourcesConfig(deps.cwd);
  const ran: Outcome = { kind: "ran", highFindings: 0, drift: false };
  if (args.list) {
    list(config, io);
    return ran;
  }
  const id = args.id ?? "";
  const placed = config ? assertionsOf(config) : [];
  if (!config || !placed.some((p) => p.assertion.id === id))
    throw new ConfigError(`${SOURCES_CONFIG_FILE} has no assertion called "${id}".`, {
      hint:
        placed.length > 0
          ? `The ones set up: ${placed.map((p) => p.assertion.id).join(", ")}.`
          : `No data assertions are set up. Add an "assertions" list to ${SOURCES_CONFIG_FILE}.`,
    });
  // Connection strings and keys are copied from the environment here and read by the connector only.
  const read = await readAssertions(
    { config, env: freezeEnv(io.env ?? {}, databaseEnvVars(config)) },
    createFetcher({}),
    { only: [id] },
  );
  if (!args.quiet) for (const n of read.notices) io.stderr.write(`${n.message}\n`);
  const result = read.results[0];
  if (!result) throw new ConfigError(`The assertion "${id}" was not run.`);
  switch (result.status) {
    case "config-error":
      throw new ConfigError(result.message ?? `The assertion "${id}" is wrong.`, {
        hint: `Fix it in ${SOURCES_CONFIG_FILE} (see docs/guides/data-assertions).`,
      });
    case "passed":
      io.stdout.write(`\u2713 ${id}: no rows, so it passes\n`);
      return ran;
    case "could-not-check":
      io.stdout.write(`? ${result.message ?? `The assertion "${id}" could not be checked.`}\n`);
      return { kind: "ran", highFindings: 0, drift: false, incomplete: true };
    case "failed":
      io.stdout.write(`\u2717 ${result.title}\n    ${describeAssertion(result)}\n`);
      // Exit 1 for any severity: this command exists to ask one question about the data.
      return { kind: "ran", highFindings: 0, drift: true };
    default: {
      const never: never = result.status;
      return never;
    }
  }
}
