import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Where the built app lives. In the published package the CLI is dist/index.js and its chunks, and the
 * client is the folder dist/client beside it. Run from source (the tests), this file is
 * src/client-dir.ts, and the build put the client in ../dist/client.
 */
export function defaultClientDir(
  here: string = import.meta.url,
  exists: (path: string) => boolean = existsSync,
): string {
  const beside = fileURLToPath(new URL("./client/", here));
  if (exists(beside)) return beside;
  const fromSource = fileURLToPath(new URL("../dist/client/", here));
  return exists(fromSource) ? fromSource : beside;
}
