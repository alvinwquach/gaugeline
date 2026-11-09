import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

/** A small invented client: an index.html that points at a hashed script and a hashed stylesheet. */
export const SAMPLE_FILES: Record<string, string> = {
  "index.html":
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Gaugeline</title>' +
    '<script type="module" crossorigin src="./assets/app-aB3dE5gH.js"></script>' +
    '<link rel="stylesheet" crossorigin href="./assets/app-kL7mN9pQ.css"></head>' +
    '<body><div id="root">Gaugeline is running on this computer.</div></body></html>\n',
  "assets/app-aB3dE5gH.js": 'document.getElementById("root").dataset.ready = "yes";\n',
  "assets/app-kL7mN9pQ.css": "body{margin:0}\n",
};

export interface Entry {
  path: string;
  type: string;
  bytes: number;
  gzipBytes: number;
  sha256: string;
}

/**
 * Write files and a client-manifest.json for them into a new temp folder. The manifest is written
 * here, on purpose not by scripts/embed-client.mjs: the server is tested against the documented format.
 */
export function makeClientDir(
  files: Record<string, string | Buffer> = SAMPLE_FILES,
  edit: (entries: Entry[]) => Entry[] = (e) => e,
): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-client-"));
  const entries: Entry[] = [];
  for (const [path, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
    entries.push({
      path,
      // The server derives the type from the extension and ignores this field.
      type: "application/octet-stream",
      bytes: body.length,
      gzipBytes: gzipSync(body).length,
      sha256: createHash("sha256").update(body).digest("hex"),
    });
  }
  writeFileSync(join(dir, "client-manifest.json"), JSON.stringify(edit(entries), null, 2));
  return dir;
}

const made: string[] = [];
process.on("exit", () => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** The sample client, made once per test process. */
let shared: string | undefined;
export function testClientDir(): string {
  if (!shared) {
    shared = makeClientDir();
    made.push(shared);
  }
  return shared;
}

/** A client folder that is removed when the process ends. */
export function scratchClientDir(
  files?: Record<string, string | Buffer>,
  edit?: (entries: Entry[]) => Entry[],
): string {
  const dir = makeClientDir(files, edit);
  made.push(dir);
  return dir;
}
