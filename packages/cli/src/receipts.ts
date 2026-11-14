import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConfigError, verifyApprovalReceipts, type Outcome } from "@gaugeline/core";

interface Out {
  stdout: { write(s: string): unknown };
}

/** The chain file inside a folder, and the folder of payloads beside it. */
export const CHAIN_FILE = "receipts.jsonl";
export const PAYLOADS_DIR = "payloads";
const MAX_CHAIN_BYTES = 64 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_PAYLOADS = 10_000;
const PAYLOAD_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.txt$/;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function readUtf8(path: string, shown: string, max: number): string {
  let bytes: Buffer;
  try {
    if (statSync(path).size > max)
      throw new ConfigError(`${shown} is larger than ${max / (1024 * 1024)} MB.`);
    bytes = readFileSync(path);
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`Could not read ${shown}.`, {
      hint: "Give the chain file (receipts.jsonl) or the folder that holds it.",
      cause: e,
    });
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ConfigError(`${shown} is not UTF-8 text.`, {
      hint: "A receipt chain is JSON lines in UTF-8, as the hosted export writes it.",
    });
  }
}

/** The chain's text and the payloads beside it. Throws ConfigError (exit 2) when they cannot be read. */
function readChain(cwd: string, typed: string): { text: string; payloads: Map<string, string> } {
  const path = resolve(cwd, typed);
  let isFolder: boolean;
  try {
    isFolder = statSync(path).isDirectory();
  } catch (e) {
    throw new ConfigError(`Could not read ${typed}: there is no such file or folder.`, {
      hint: "Give the chain file (receipts.jsonl) or the folder that holds it.",
      cause: e,
    });
  }
  const payloads = new Map<string, string>();
  if (!isFolder) return { text: readUtf8(path, typed, MAX_CHAIN_BYTES), payloads };
  const chain = join(path, CHAIN_FILE);
  const text = readUtf8(chain, `${typed}/${CHAIN_FILE}`, MAX_CHAIN_BYTES);
  const dir = join(path, PAYLOADS_DIR);
  let names: string[] = [];
  try {
    if (statSync(dir).isDirectory()) names = readdirSync(dir).sort();
  } catch {
    names = [];
  }
  if (names.length > MAX_PAYLOADS)
    throw new ConfigError(`${typed}/${PAYLOADS_DIR} holds more than ${MAX_PAYLOADS} files.`);
  for (const name of names) {
    const id = PAYLOAD_NAME.exec(name)?.[1];
    if (id === undefined)
      throw new ConfigError(
        `${typed}/${PAYLOADS_DIR}/${name} is not a payload file: each is named <draft id>.txt.`,
        { hint: "Move other files out of the payloads folder, so nothing in it goes unchecked." },
      );
    payloads.set(
      id,
      readUtf8(join(dir, name), `${typed}/${PAYLOADS_DIR}/${name}`, MAX_PAYLOAD_BYTES),
    );
  }
  return { text, payloads };
}

/**
 * gaugeline receipts verify <file|folder>: check an exported chain of approval receipts (AG-06) with
 * core's verifier, the same function the hosted export test uses. Reads files and nothing else: no
 * request, no key. Exit 0 when the chain checks out, 1 at the first broken receipt, 2 (a ConfigError)
 * when it cannot be read. A payload's text is never printed.
 */
export function runReceipts(
  args: { path: string; head?: string; json: boolean },
  io: Out,
  deps: { cwd: string },
): Outcome {
  const { text, payloads } = readChain(deps.cwd, args.path);
  const verdict = verifyApprovalReceipts(text, {
    payloads,
    ...(args.head !== undefined ? { head: args.head } : {}),
  });
  const outcome: Outcome = { kind: "ran", highFindings: verdict.ok ? 0 : 1, drift: false };
  if (args.json) {
    const { ok, receipts, verified, org, head, problem } = verdict;
    io.stdout.write(
      `${JSON.stringify({ ok, receipts, verified, payloads: payloads.size, org, head, ...(problem ? { problem } : {}) }, null, 2)}\n`,
    );
    return outcome;
  }
  const lines: string[] = [];
  const problem = verdict.problem;
  if (problem) {
    const where =
      problem.index < verdict.receipts
        ? `receipt ${problem.index + 1} (line ${problem.line})`
        : "the end of the chain";
    lines.push(
      `The chain breaks at ${where}: ${problem.check}. ${problem.message[0]?.toUpperCase() ?? ""}${problem.message.slice(1)}.`,
      verdict.verified === 0
        ? `No receipt before it checks out; nothing from ${where} on can be trusted.`
        : `${plural(verdict.verified, "receipt")} before it ${verdict.verified === 1 ? "checks" : "check"} out; nothing from ${where} on can be trusted.`,
    );
  } else if (verdict.receipts === 0) {
    lines.push("The chain has no receipts: nothing to check.");
  } else {
    lines.push(
      `Checked ${plural(verdict.receipts, "receipt")} for organisation ${verdict.org ?? ""}: the chain is intact.`,
      "Every receipt's hash matches its fields, each links to the one before, and the first to the genesis value.",
    );
    if (payloads.size > 0)
      lines.push(`${plural(payloads.size, "payload")} beside the chain hash to their receipts.`);
    lines.push(`Head: ${verdict.head}`);
    if (args.head !== undefined) lines.push("The head given with --head is in the chain.");
  }
  lines.push(
    "",
    "This is tamper evidence, not a signature: whoever controls the database can rebuild the whole chain.",
    "Keep the head hash somewhere the database's operator does not control and check later exports with --head.",
  );
  io.stdout.write(`${lines.join("\n")}\n`);
  return outcome;
}
