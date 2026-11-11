import { describe, expect, it } from "vitest";
import { page } from "../../checks/__tests__/helpers.js";
import { HOSTED_BUILDERS, detectBuilder } from "../builders.js";

const withBody = (body: string, headers: Record<string, string> = {}, scripts: string[] = []) =>
  page({
    scripts,
    hops: [
      {
        url: "https://shop.example/",
        status: 200,
        headers: { "content-type": "text/html", ...headers },
        body,
        ms: 1,
      },
    ],
  });

describe("detectBuilder: sites on a hosted builder have a fixed plan", () => {
  it.each([
    ["wix", withBody('<meta name="generator" content="Wix.com Website Builder">')],
    ["wix", withBody("<p>hi</p>", { "x-wix-request-id": "1699-abc" })],
    ["wix", withBody("<p>hi</p>", {}, ["https://static.parastorage.com/services/x.js"])],
    ["squarespace", withBody('<meta name="generator" content="Squarespace 7.1">')],
    ["squarespace", withBody("<p>hi</p>", { server: "Squarespace" })],
    ["squarespace", withBody("<p>hi</p>", {}, ["https://static1.squarespace.com/static/x.js"])],
    ["webflow", withBody('<html data-wf-domain="x.example" data-wf-site="64f"><p>hi</p>')],
    ["webflow", withBody('<meta content="Webflow" name="generator">')],
    ["webflow", withBody("<p>hi</p>", {}, ["https://cdn.prod.website-files.com/64f/js/x.js"])],
    ["framer", withBody('<meta name="generator" content="Framer 4f2a">')],
    ["framer", withBody("<p>hi</p>", {}, ["https://framerusercontent.com/sites/x.mjs"])],
  ] as const)("%s", (id, snapshot) => {
    expect(detectBuilder(snapshot)?.id).toBe(id);
  });

  it("is undefined for a Next.js site on Vercel", () => {
    const next = withBody("<p>hi</p>", { "x-vercel-id": "lhr1::abc", "x-powered-by": "Next.js" }, [
      "https://marlowe-bar.example/_next/static/chunks/main.js",
    ]);
    expect(detectBuilder(next)).toBeUndefined();
  });

  it("does not take a word in the page's text for a builder", () => {
    expect(
      detectBuilder(withBody("<p>We built this on Wix, then left Squarespace.</p>")),
    ).toBeUndefined();
  });

  it("names every builder the spec lists", () => {
    expect(HOSTED_BUILDERS.map((b) => b.id).sort()).toEqual([
      "framer",
      "squarespace",
      "webflow",
      "wix",
    ]);
    for (const b of HOSTED_BUILDERS) expect(b.name.length).toBeGreaterThan(2);
  });
});
