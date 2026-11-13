import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPlaywrightRenderer } from "@gaugeline/renderer";
import { describe, expect, it } from "vitest";
import {
  html,
  startServer,
  type FixtureServer,
} from "../../../core/src/__tests__/helpers/server.js";
import { EXIT, main } from "../main.js";
import { afterAll, beforeAll } from "vitest";

/**
 * docs/rendered-pages.md shows what `--renderer playwright` prints when there is no browser. This runs the
 * command with a browser path that is not there and compares what it prints on stderr with the page's block.
 */
const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/rendered-pages.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const block = (title: string): string =>
  new RegExp('```[a-z]* title="?' + title + '"?\\n([\\s\\S]*?)\\n```').exec(page)?.[1] ?? "";

let site: FixtureServer;
beforeAll(async () => {
  site = await startServer({
    "/": html("<html><head><title>Quillfeather</title></head><body><h1>Bread</h1></body></html>"),
  });
});
afterAll(async () => {
  await site.close();
});

describe("docs/rendered-pages.md: the command it shows", () => {
  it("prints the message the page shows when the browser file is not there", async () => {
    let err = "";
    const code = await main(
      [site.origin, "--allow-private", "--no-open", "--renderer", "playwright"],
      {
        stdout: { write: () => true },
        stderr: { write: (s: string) => ((err += s), true) },
        env: { GAUGELINE_BROWSER_PATH: "/nowhere/chrome" },
      },
      {
        renderer: ({ transport }) =>
          createPlaywrightRenderer({
            transport,
            env: { GAUGELINE_BROWSER_PATH: "/nowhere/chrome" },
            loadDriver: () =>
              Promise.resolve({ chromium: { executablePath: () => "/x" } } as never),
          }),
      },
    );
    expect(code).toBe(EXIT.ok);
    // The page shows the path the way the docs runner does: a folder reads as "./".
    const shown = block("Output").replace("./chrome", "/nowhere/chrome");
    expect(err).toContain(shown);
  });

  it("names the one flag and the one renderer", () => {
    expect(page).toContain("--renderer playwright");
    expect(block("Output")).toContain("npx playwright install chromium");
  });
});
