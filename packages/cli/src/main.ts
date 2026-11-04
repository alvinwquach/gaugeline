import { parseCliArgs, USAGE } from "./args.js";
import { VERSION } from "./version.js";

export interface Io {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}

/** Exit codes are a public contract: 0 ran, 1 --ci found fix-first work, 2 could not run. */
export const EXIT = { ok: 0, findings: 1, couldNotRun: 2 } as const;

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const args = parseCliArgs(argv);
  switch (args.kind) {
    case "help":
      io.stdout.write(`${USAGE}\n`);
      return EXIT.ok;
    case "version":
      io.stdout.write(`${VERSION}\n`);
      return EXIT.ok;
    case "error":
      io.stderr.write(`gaugeline: ${args.message}\n`);
      if (args.showUsage) io.stderr.write(`\n${USAGE}\n`);
      return EXIT.couldNotRun;
    case "run":
      io.stdout.write(`Gaugeline ${VERSION} checking ${args.address}\n`);
      return EXIT.ok;
  }
}
