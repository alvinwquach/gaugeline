import { createReadStream, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  ConfigError,
  formatSummary,
  NoAddressColumnError,
  summariseStream,
  type CrawlSummary,
  type Outcome,
} from "@gaugeline/core";

/**
 * gaugeline verify <export.csv>: the export is read as a stream (a 200,000-row file never sits in
 * memory whole), classified and summarised. No request is made.
 */
export async function runVerify(
  args: { file: string; quiet: boolean },
  io: { stdout: { write(s: string): unknown }; stderr: { write(s: string): unknown } },
  cwd: string,
): Promise<{ outcome: Outcome; summary: CrawlSummary }> {
  const path = resolve(cwd, args.file);
  if (!existsSync(path)) throw new ConfigError(`${args.file} does not exist.`);
  const stream = createReadStream(path);
  // Windows keeps a file open until its stream says closed: wait for that, not just the last chunk.
  const closed = new Promise<void>((r) => stream.once("close", () => r()));
  let read;
  try {
    read = await summariseStream(stream);
  } catch (err) {
    if (err instanceof NoAddressColumnError)
      throw new ConfigError(`${args.file}: ${err.message}`, {
        hint: "Export with the crawler's Address or URL column included.",
      });
    throw new ConfigError(`${args.file} could not be read: ${(err as Error).message}`);
  } finally {
    stream.destroy();
    await closed;
  }
  if (!args.quiet) for (const w of read.warnings) io.stderr.write(`${w}\n`);
  io.stdout.write(`${formatSummary(read.summary)}\n`);
  return { outcome: { kind: "ran", highFindings: 0, drift: false }, summary: read.summary };
}
