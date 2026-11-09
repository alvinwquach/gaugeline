import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildNote } from "../note";

const page = readFileSync(
  fileURLToPath(new URL("../../../../../docs/the-app.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

describe("the note shown in docs/the-app.md", () => {
  it("is what buildNote makes for the finding the images fixture produces", () => {
    // The finding is the one the app reports for the `images` fixture (the broken image), with the
    // fixture's origin shown as the page's address, the way the rest of the docs do.
    const note = buildNote(
      {
        checkId: "images-broken",
        severity: "high",
        title: "Some images on this page don't load",
        url: "https://shop.example/img/missing.png",
        evidence: '<img src="/img/missing.png"> returned 404',
      },
      { url: "https://shop.example/" },
    );
    const block = /```text title=Copied note\n([\s\S]*?)\n```/.exec(page)?.[1];
    expect(block).toBe(note);
  });
});
