import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DOCUMENTS_CONFIG_FILE, readDocumentsConfig } from "../schema-config.js";

const dirs: string[] = [];
function folder(file?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-documents-"));
  dirs.push(dir);
  if (file !== undefined) writeFileSync(join(dir, DOCUMENTS_CONFIG_FILE), JSON.stringify(file));
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("gaugeline.documents.json", () => {
  it("is optional", () => {
    expect(readDocumentsConfig(folder())).toBeUndefined();
  });

  it("reads include, exclude and the size limit", () => {
    const config = {
      documents: { include: ["/catering.pdf"], exclude: ["/press/"], maxMegabytes: 15 },
    };
    expect(readDocumentsConfig(folder(config))).toEqual(config);
  });

  it("refuses a key it does not know, and a limit over 25 MB", () => {
    expect(() => readDocumentsConfig(folder({ documents: { include: [], ocr: true } }))).toThrow(
      /documents/,
    );
    expect(() => readDocumentsConfig(folder({ documents: { maxMegabytes: 40 } }))).toThrow(
      /maxMegabytes/,
    );
  });
});
