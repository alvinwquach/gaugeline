import { describe, expect, it } from "vitest";
import { findLeaks } from "../leaks/detectors.js";
import { secretInJs } from "../secret-in-js.js";
import { buildSnapshot } from "../../snapshot.js";

/**
 * A Contentstack preview token in a page's JavaScript (C-26's second extra check, which reuses the leaks
 * detectors of G12). Tokens are built at run time: a key-shaped string in source is refused by push protection.
 * Every value is invented. The shape ("cs" and hex) is from memory and uncited, so a match also needs the
 * word preview (in the name, or the Live Preview host in the same object).
 */
const hex = (seed: string, n = 26) => (seed.repeat(8) + "0123456789abcdef").slice(0, n);
const preview = "cs" + hex("a1b2c3");
const delivery = "cs" + hex("d4e5f6");
const stackKey = "blt" + hex("0a1b2c", 16);
const ids = (text: string) => findLeaks(text).map((l) => l.detector);

const page = (body: string) =>
  buildSnapshot([
    {
      url: "https://harbour-lantern.example/",
      status: 200,
      headers: { "content-type": "text/html" },
      body,
      ms: 1,
    },
  ]);

describe("contentstack-preview-token", () => {
  it("is found: the name says preview in a file that names Contentstack, or the Live Preview host is in the same object", () => {
    for (const hit of [
      `Contentstack.Stack({api_key:"${stackKey}",delivery_token:"${delivery}",environment:"production",live_preview:{enable:true,preview_token:"${preview}"}})`,
      `const contentstackPreviewToken = "${preview}";`,
      `new Contentstack({ previewToken: '${preview}' })`,
      `{ enable: true, host: "rest-preview.contentstack.com", token: "${preview}" }`,
      `{ token: "${preview}", host: "eu-rest-preview.contentstack.com" }`,
    ])
      expect(ids(hit), hit).toEqual(["contentstack-preview-token"]);
    const [leak] = findLeaks(`contentstack({preview_token:"${preview}"})`);
    expect(leak?.label).toBe("Contentstack preview token");
    expect(leak?.redacted).toBe("");
  });

  it("is not found: a delivery token, a stack key, a preview word with no Contentstack, a short or odd value", () => {
    for (const miss of [
      // Public by design: a delivery token and the stack's API key.
      `Contentstack.Stack({api_key:"${stackKey}",delivery_token:"${delivery}",environment:"production"})`,
      `{ access_token: "${delivery}", host: "cdn.contentstack.io" }`,
      // The word preview, in a file that is not Contentstack's.
      `const previewToken = "${preview}";`,
      // The preview host is in another object than the token.
      `var a={host:"rest-preview.contentstack.com"};var b={token:"${preview}"}`,
      // Too short, not hex, not a cs value.
      `contentstack({preview_token:"cs${hex("a1", 10)}"})`,
      `contentstack({preview_token:"cs${"z".repeat(26)}"})`,
      `contentstack({preview_token:"xx${hex("a1b2c3")}"})`,
      // A value that is only mentioned, not assigned.
      `// contentstack preview_token ${preview}`,
    ])
      expect(ids(miss), miss).not.toContain("contentstack-preview-token");
  });

  it("a page with a preview token gives exactly one secret-in-js finding with no character of the token; a delivery token gives none", async () => {
    const quiet = page(
      `<script>Contentstack.Stack({api_key:"${stackKey}",delivery_token:"${delivery}",environment:"production"})</script>`,
    );
    expect(await secretInJs.run(quiet, { warn: () => undefined })).toEqual([]);
    const loud = page(
      `<script>Contentstack.Stack({api_key:"${stackKey}",delivery_token:"${delivery}",live_preview:{enable:true,preview_token:"${preview}"}})</script>`,
    );
    const findings = await secretInJs.run(loud, { warn: () => undefined });
    expect(findings.map((f) => f.evidence)).toEqual([
      expect.stringMatching(/^Contentstack preview token in inline script 1 on .* at byte \d+$/),
    ]);
    const shown = JSON.stringify(findings);
    for (const part of [preview, preview.slice(0, 6), preview.slice(-2), delivery, stackKey])
      expect(shown).not.toContain(part);
  });
});
