import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher } from "../../fetcher.js";
import { checkSite } from "../../site.js";
import { buildSnapshot } from "../../snapshot.js";
import { startServer, type FixtureServer } from "../../__tests__/helpers/server.js";
import { imageWidthAbsurd } from "../image-width-absurd.js";
import { imagesAltEmpty } from "../images-alt-empty.js";
import { imagesAltMissing } from "../images-alt-missing.js";
import { hasModernCandidate, imageRefs, nextImage, parseSrcset } from "../images/refs.js";
import { page } from "./helpers.js";

const IMAGE_CHECKS = [
  "images-broken",
  "images-alt-empty",
  "images-alt-missing",
  "images-heavy",
  "images-legacy-format",
  "images-legacy-wp",
  "image-width-absurd",
];
const ctx = { warn: () => undefined };
const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** A snapshot of an HTML body at https://thread.example/. */
function snap(body: string) {
  return buildSnapshot([
    {
      url: "https://thread.example/",
      status: 200,
      headers: { "content-type": "text/html" },
      body,
      ms: 1,
    },
  ]);
}

async function runFixture() {
  const site = await startFixture("images");
  try {
    const fetcher = createFetcher({ allowPrivate: true, timeoutMs: 5000 });
    const run = await checkSite({ address: site.origin, fetcher, only: IMAGE_CHECKS });
    return { ...run, site };
  } finally {
    await site.close();
  }
}

describe("images: unit", () => {
  it("srcset parser: w and x descriptors, commas inside URLs, trailing whitespace", () => {
    expect(parseSrcset("a.jpg 480w, b.jpg 1080w")).toEqual([
      { url: "a.jpg", w: 480 },
      { url: "b.jpg", w: 1080 },
    ]);
    expect(parseSrcset("small.png, big.png 2x  ")).toEqual([
      { url: "small.png" },
      { url: "big.png", x: 2 },
    ]);
    expect(
      parseSrcset(
        "https://cdn.example/w_400,h_300/a.jpg 400w, https://cdn.example/w_800,h_600/a.jpg 800w",
      ),
    ).toEqual([
      { url: "https://cdn.example/w_400,h_300/a.jpg", w: 400 },
      { url: "https://cdn.example/w_800,h_600/a.jpg", w: 800 },
    ]);
    expect(parseSrcset("  a.jpg 1.5x ,\n b.jpg 3x\t")).toEqual([
      { url: "a.jpg", x: 1.5 },
      { url: "b.jpg", x: 3 },
    ]);
    expect(parseSrcset("")).toEqual([]);
  });

  it("/_next/image?url=%2Fhero.jpg&w=3840 yields nextImageSource /hero.jpg and triggers image-width-absurd", () => {
    expect(nextImage("https://thread.example/_next/image?url=%2Fhero.jpg&w=3840&q=75")).toEqual({
      source: "/hero.jpg",
      width: 3840,
    });
    const p = snap('<img src="/_next/image?url=%2Fhero.jpg&amp;w=3840&amp;q=75" alt="Hero">');
    expect(imageRefs(p)[0]?.nextImageSource).toBe("/hero.jpg");
    expect(imageWidthAbsurd.run(p, ctx)).toEqual([
      expect.objectContaining({
        evidence: "1 image is offered at 3840 pixels or wider: /hero.jpg (3840w)",
      }),
    ]);
    expect(
      imageWidthAbsurd.run(snap('<img src="/a.jpg" srcset="/a.jpg 3839w" alt="a">'), ctx),
    ).toEqual([]);
    expect(
      imageWidthAbsurd.run(snap('<img src="/a.jpg" srcset="/a-4k.jpg 4096w" alt="a">'), ctx),
    ).toHaveLength(1);
  });

  it("alt table: missing, empty, whitespace only, real text", () => {
    const refs = imageRefs(
      snap(
        '<img src="/1.png"><img src="/2.png" alt=""><img src="/3.png" alt="   "><img src="/4.png" alt="A loom">',
      ),
    );
    expect(refs.map((r) => r.alt)).toEqual([null, "", "   ", "A loom"]);
    // A described image exists, so the page is not "none described"; one has no alt at all.
    const mixed = snap(
      '<img src="/1.png"><img src="/2.png" alt=""><img src="/3.png" alt="   "><img src="/4.png" alt="A loom">',
    );
    expect(imagesAltEmpty.run(mixed, ctx)).toEqual([]);
    expect(imagesAltMissing.run(mixed, ctx)).toEqual([
      expect.objectContaining({ evidence: "1 image has no alt: /1.png" }),
    ]);
    // Empty and whitespace only, no text anywhere: none described.
    expect(
      imagesAltEmpty.run(snap('<img src="/2.png" alt=""><img src="/3.png" alt="  ">'), ctx),
    ).toHaveLength(1);
    expect(imagesAltEmpty.run(snap("<p>No images.</p>"), ctx)).toEqual([]);
  });

  it("data: URIs are skipped everywhere", () => {
    const p = snap(
      '<img src="data:image/png;base64,AAAA" alt=""><img src="/a.png" srcset="data:image/gif;base64,R0 1x, /a-2x.png 2x" alt="a">',
    );
    const refs = imageRefs(p);
    expect(refs.map((r) => r.src)).toEqual(["https://thread.example/a.png"]);
    expect(refs[0]?.srcset.map((c) => c.url)).toEqual(["https://thread.example/a-2x.png"]);
  });
});

describe("images: integration (fixture site)", () => {
  it("40 images: 20 or fewer image requests; one 404, one heavy image, and the rest of the findings", async () => {
    const { result, budget, site } = await runFixture();
    const imageHits = [...site.hits.entries()]
      .filter(([p]) => p !== "/")
      .reduce((n, [, c]) => n + c, 0);
    expect(imageHits).toBeLessThanOrEqual(20);
    expect(budget.summary().images).toEqual({ limit: 20, sampled: 20, found: 40 });
    const byId = (id: string) =>
      result.findings.filter((f) => f.checkId === id).map((f) => f.evidence);
    expect(byId("images-broken")).toEqual(['<img src="/img/missing.png"> returned 404']);
    expect(byId("images-heavy")).toEqual(["/img/heavy.jpg is 879 KB (Content-Length 900,000)"]);
    expect(byId("images-alt-missing")).toEqual([
      "2 images have no alt: /img/swatch-0.png, /img/swatch-1.png",
    ]);
    expect(byId("images-alt-empty")).toEqual([]);
    expect(byId("images-legacy-wp")).toEqual([
      "1 image loads from /wp-content/uploads/: /wp-content/uploads/2019/05/old-sign.jpg",
    ]);
    expect(byId("image-width-absurd")).toEqual([
      "1 image is offered at 3840 pixels or wider: /hero.jpg (3840w)",
    ]);
    // heavy.jpg, old-sign.jpg, divider.png and swatch-0 to swatch-12: JPEG or PNG with no modern candidate.
    expect(byId("images-legacy-format")[0]).toMatch(
      /^16 of 20 sampled images are JPEG, PNG or GIF only: \/img\/heavy\.jpg, /,
    );
  });

  it("an image with no Content-Length header gives no images-heavy finding", async () => {
    const { result } = await runFixture();
    expect(
      result.findings.filter((f) => f.checkId === "images-heavy").map((f) => f.url),
    ).not.toContainEqual(expect.stringContaining("divider"));
  });
});

describe("images: promise test", () => {
  it("no image body is read: every image request is HEAD, or GET after a 405", async () => {
    const send405 = (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "HEAD") res.writeHead(405).end();
      else
        res
          .writeHead(200, { "content-type": "image/png", "content-length": "10" })
          .end("0123456789");
    };
    const server = await startServer({
      "/": (_req, res) => {
        res
          .writeHead(200, { "content-type": "text/html" })
          .end('<title>t</title><img src="/a.png" alt="a"><img src="/b.png" alt="b">');
      },
      "/a.png": (_req, res) => {
        res.writeHead(200, { "content-type": "image/png" }).end();
      },
      "/b.png": send405,
    });
    servers.push(server);
    await checkSite({
      address: `${server.origin}/`,
      fetcher: createFetcher({ allowPrivate: true }),
      only: IMAGE_CHECKS,
    });
    const images = server.log.filter((r) => r.path !== "/");
    expect(images.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      "GET /b.png",
      "HEAD /a.png",
      "HEAD /b.png",
    ]);
  });
});

describe("images: edge cases", () => {
  it("a picture with an AVIF source and a JPEG fallback is not legacy-format; an SVG never is", async () => {
    const { result } = await runFixture();
    const legacy =
      result.findings.find((f) => f.checkId === "images-legacy-format")?.evidence ?? "";
    expect(legacy).not.toContain("garden");
    expect(legacy).not.toContain("logo.svg");
    const pic = imageRefs(
      snap(
        '<picture><source type="image/avif" srcset="/g.avif"><img src="/g.jpg" alt="g"></picture>',
      ),
    );
    expect(hasModernCandidate(pic[0]!)).toBe(true);
  });

  it('one decorative alt="" among described images produces neither alt finding', () => {
    const p = snap(
      '<img src="/a.png" alt="A loom"><img src="/rule.png" alt=""><img src="/b.png" alt="Thread">',
    );
    expect(imagesAltEmpty.run(p, ctx)).toEqual([]);
    expect(imagesAltMissing.run(p, ctx)).toEqual([]);
  });

  it("an image on another host is not sampled and not reported as broken", async () => {
    const { result, site } = await runFixture();
    expect(result.findings.some((f) => f.url.includes("cdn.other.example"))).toBe(false);
    expect([...site.hits.keys()].some((p) => p.includes("sewing"))).toBe(false);
  });

  it("with no image sample in the context, the sampled checks find nothing", async () => {
    const { imagesBroken } = await import("../images-broken.js");
    expect(await imagesBroken.run(page(), ctx)).toEqual([]);
  });
});
