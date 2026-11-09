import {
  accessSync,
  closeSync,
  constants,
  openSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { ConfigError } from "@gaugeline/core";

/**
 * The file --save-requests writes. It is claimed before the first request: a folder, a missing
 * folder or a file that cannot be replaced is exit 2 then, not after a whole check. A new file is
 * created with mode 0600 (owner only); where the OS has no such modes (Windows) the folder's own
 * permissions apply. If the check then fails, a file this run created is removed again, and a file
 * that was already there is untouched until the real one is written.
 */
export interface RequestsFileTarget {
  /** Replace the file's contents with the finished file. Throws a ConfigError when that fails. */
  write(text: string): void;
  /** Remove the empty file this run created, when the check did not finish. */
  discard(): void;
  /** Await `work`; if it rejects, discard first. */
  guard<T>(work: Promise<T>): Promise<T>;
}

const codeOf = (err: unknown): string => (err as { code?: string }).code ?? "an error";

function cannotWrite(shown: string, err: unknown): ConfigError {
  return new ConfigError(`--save-requests: ${shown} cannot be written (${codeOf(err)}).`, {
    hint: "Choose a file in a folder you can write to.",
  });
}

export function reserveRequestsFile(shown: string, path: string): RequestsFileTarget {
  let created = false;
  let info: ReturnType<typeof statSync> | undefined;
  try {
    info = statSync(path);
  } catch (err) {
    if (codeOf(err) !== "ENOENT") throw cannotWrite(shown, err);
  }
  if (info?.isDirectory())
    throw new ConfigError(`--save-requests: ${shown} is a folder, not a file.`, {
      hint: "Give a file name, such as requests.json.",
    });
  if (info === undefined) {
    try {
      // "wx": never follows a file that appeared meanwhile. 0600 applies to a file made here.
      closeSync(openSync(path, "wx", 0o600));
      created = true;
    } catch (err) {
      throw cannotWrite(shown, err);
    }
  } else {
    try {
      accessSync(path, constants.W_OK);
    } catch (err) {
      throw cannotWrite(shown, err);
    }
  }
  const discard = (): void => {
    if (!created) return;
    created = false;
    try {
      unlinkSync(path);
    } catch {
      // Already gone, or not ours to remove any more: nothing to do.
    }
  };
  return {
    write(text) {
      try {
        writeFileSync(path, text, { mode: 0o600 });
        created = false;
      } catch (err) {
        discard();
        throw new ConfigError(
          `Could not write the request log to ${shown} (${codeOf(err)}); the results above are complete.`,
          { hint: "Choose a file in a folder you can write to." },
        );
      }
    },
    discard,
    async guard(work) {
      try {
        return await work;
      } catch (err) {
        discard();
        throw err;
      }
    },
  };
}
