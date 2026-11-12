import { describe, expect, it } from "vitest";
import { findLeaks } from "../leaks/detectors.js";
import { secretInJs } from "../secret-in-js.js";
import { buildSnapshot } from "../../snapshot.js";

/**
 * A Storyblok preview token in a page's JavaScript (the extra check of C-08, which reuses the leaks detectors of G12).
 * Tokens are built at run time: a key-shaped string in source is refused by push protection. Every value is invented.
 * A public and a preview token look the same (letters and digits, uncited: the shape is from memory), so a match also
 * needs a word that says preview: in the name of the value in a file that names Storyblok, or a draft version asked
 * for in the same object.
 */
const alnum = (seed: string, n = 24) => (seed.repeat(8) + "Zy9Xw8Vu7Ts6Rq5").slice(0, n);
const preview = alnum("kQ3mP");
const publicTok = alnum("rT7nB");
const ids = (text: string) => findLeaks(text).map((l) => l.detector);

const page = (body: string) =>
  buildSnapshot([
    {
      url: "https://larkspur-yoga.example/",
      status: 200,
      headers: { "content-type": "text/html" },
      body,
      ms: 1,
    },
  ]);

describe("storyblok-preview-token", () => {
  it("is found: the name says preview in a file that names Storyblok, or a draft version is asked for in the same object", () => {
    for (const hit of [
      `storyblokInit({accessToken:"${publicTok}",use:[apiPlugin]});const previewToken="${preview}";`,
      `const storyblokPreviewToken = "${preview}";`,
      `new StoryblokClient({ previewToken: '${preview}' })`,
      `storyblokApi.get("cdn/stories",{version:"draft",token:"${preview}"})`,
      `{ token: "${preview}", version: 'draft' }`,
    ])
      expect(ids(hit), hit).toEqual(["storyblok-preview-token"]);
    const [leak] = findLeaks(`storyblok({preview_token:"${preview}"})`);
    expect(leak?.label).toBe("Storyblok preview token");
    expect(leak?.redacted).toBe("");
  });

  it("is not found: a public token, a preview word with no Storyblok, a published version, a short or odd value", () => {
    for (const miss of [
      // Public by design: the public access token of a space.
      `storyblokInit({accessToken:"${publicTok}",use:[apiPlugin]})`,
      `storyblokApi.get("cdn/stories",{version:"published",token:"${publicTok}"})`,
      // The word preview, in a file that is not Storyblok's.
      `const previewToken = "${preview}";`,
      // The draft version is in another object than the token.
      `var a={version:"draft"};var b={token:"${publicTok}"}`,
      // Too short, or not letters and digits.
      `storyblok({preview_token:"${alnum("kQ", 8)}"})`,
      `storyblok({preview_token:"${"-".repeat(24)}"})`,
      // A value that is only mentioned, not assigned.
      `// storyblok preview_token ${preview}`,
    ])
      expect(ids(miss), miss).not.toContain("storyblok-preview-token");
  });

  it("a public token next to a draft query in another object is not a leak, and a preview token beside it is the only finding", () => {
    const nested = `storyblokInit({accessToken:"${publicTok}",options:{version:"draft"}})`;
    expect(ids(nested)).not.toContain("storyblok-preview-token");
    const both = `storyblokInit({accessToken:"${publicTok}",options:{version:"draft",token:"${preview}"}})`;
    const found = findLeaks(both).filter((l) => l.detector === "storyblok-preview-token");
    expect(found).toHaveLength(1);
    expect(both.slice(found[0]?.offset, (found[0]?.offset ?? 0) + preview.length)).toBe(preview);
  });

  it("a page with a preview token gives exactly one secret-in-js finding with no character of the token; a public token gives none", async () => {
    const quiet = page(`<script>storyblokInit({accessToken:"${publicTok}"})</script>`);
    expect(await secretInJs.run(quiet, { warn: () => undefined })).toEqual([]);
    const loud = page(
      `<script>storyblokInit({accessToken:"${publicTok}"});get({version:"draft",token:"${preview}"})</script>`,
    );
    const findings = await secretInJs.run(loud, { warn: () => undefined });
    expect(findings.map((f) => f.evidence)).toEqual([
      expect.stringMatching(/^Storyblok preview token in inline script 1 on .* at byte \d+$/),
    ]);
    const shown = JSON.stringify(findings);
    for (const part of [preview, preview.slice(0, 6), preview.slice(-2), publicTok])
      expect(shown).not.toContain(part);
  });
});
