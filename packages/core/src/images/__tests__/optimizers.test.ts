import { describe, expect, it } from "vitest";
import { buildSnapshot } from "../../snapshot.js";
import { imagesConfigSchema } from "../config.js";
import {
  buildProbe,
  findOptimizerAddresses,
  probeRefusal,
  readImageSettings,
  sniffImage,
} from "../optimizers.js";

/**
 * The pure part of the image optimizer checks (XF-04, ADR-0007): finding an optimizer's addresses
 * in a page, reading a framework settings file for an allowlist that is too wide, judging the
 * address the owner chose for the probe, and recognising an image from its first bytes. No request.
 * Harbour Lane Books is an invented bookshop.
 */

const ORIGIN = "https://harbour-lane.example";

function pageWith(body: string) {
  return buildSnapshot([
    {
      url: `${ORIGIN}/`,
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><head><title>Harbour Lane Books</title></head><body>${body}</body></html>`,
      ms: 1,
    },
  ]);
}

describe("findOptimizerAddresses: unit", () => {
  it("reads the five address shapes from img, srcset and source", () => {
    const page = pageWith(`
      <img src="/_next/image?url=%2Fshelf.jpg&w=640&q=75" alt="">
      <img src="/_vercel/image?url=%2Fdesk.jpg&w=256&q=70" alt="">
      <img src="/_image?href=%2F_astro%2Fcat.png&w=300&f=webp" alt="">
      <img src="/.netlify/images?url=/cat.png&w=400" alt="">
      <picture><source srcset="/_ipx/w_320,f_webp/https%3A%2F%2Fcdn.harbour-lane.example%2Fa.png 320w"><img src="/a.png" alt=""></picture>`);
    const found = findOptimizerAddresses(page);
    expect(found.map((a) => a.optimizer).sort()).toEqual([
      "astro",
      "ipx",
      "netlify",
      "next",
      "vercel",
    ]);
    const next = found.find((a) => a.optimizer === "next");
    expect(next).toMatchObject({ path: "/_next/image", width: 640, quality: 75 });
    const ipx = found.find((a) => a.optimizer === "ipx");
    expect(ipx).toMatchObject({
      path: "/_ipx/",
      width: 320,
      modifiers: "w_320,f_webp",
      sourceHost: "cdn.harbour-lane.example",
    });
  });

  it("records the host an address already carries, encoded or not", () => {
    const page = pageWith(
      `<img src="/_next/image?url=https%3A%2F%2Fimages.harbour-lane.example%2Fa.jpg&w=640&q=75" alt="">
       <img src="/_next/image?url=https://cdn2.harbour-lane.example/b.jpg&w=384" alt="">`,
    );
    const hosts = findOptimizerAddresses(page).map((a) => a.sourceHost);
    expect(hosts).toEqual(["images.harbour-lane.example", "cdn2.harbour-lane.example"]);
  });

  it("ignores look-alike paths, other origins and pages with no optimizer", () => {
    const page = pageWith(`
      <img src="/_images/a.png" alt=""><img src="/_next/static/media/a.png" alt="">
      <img src="https://elsewhere.example/_next/image?url=%2Fa.png&w=64" alt="">
      <img src="/shelf.jpg" alt="">`);
    expect(findOptimizerAddresses(page)).toEqual([]);
  });

  it("reads og:image too", () => {
    const page = buildSnapshot([
      {
        url: `${ORIGIN}/`,
        status: 200,
        headers: { "content-type": "text/html" },
        body: `<html><head><meta property="og:image" content="${ORIGIN}/_next/image?url=%2Fog.png&w=1200&q=75"></head></html>`,
        ms: 1,
      },
    ]);
    expect(findOptimizerAddresses(page).map((a) => a.optimizer)).toEqual(["next"]);
  });
});

describe("readImageSettings: unit", () => {
  const next = (patterns: string) =>
    `module.exports = {\n  images: {\n    remotePatterns: [\n${patterns}\n    ],\n  },\n};\n`;

  it("a wildcard hostname is wide, with its line", () => {
    for (const h of ["**", "*", "**.*", "**.com"]) {
      const issues = readImageSettings(
        "next.config.js",
        next(`      { protocol: "https", hostname: "${h}" },`),
      );
      expect(issues).toEqual([
        expect.objectContaining({ kind: "wide", file: "next.config.js", line: 4 }),
      ]);
    }
  });

  it("an https-only pattern with no hostname is wide", () => {
    const issues = readImageSettings(
      "astro.config.mjs",
      `export default { image: { remotePatterns: [{ protocol: "https" }] } };`,
    );
    expect(issues).toEqual([expect.objectContaining({ kind: "wide", line: 1 })]);
  });

  it("a domains list holding a wildcard is wide", () => {
    const issues = readImageSettings(
      "nuxt.config.ts",
      `export default { image: {\n  domains: ["images.harbour-lane.example", "*"],\n} };`,
    );
    expect(issues).toEqual([expect.objectContaining({ kind: "wide", line: 2 })]);
  });

  it("a tight list gives nothing", () => {
    expect(
      readImageSettings(
        "next.config.js",
        next(
          `      { protocol: "https", hostname: "images.harbour-lane.example", pathname: "/books/**" },\n      { protocol: "https", hostname: "**.cdn.harbour-lane.example" },`,
        ),
      ),
    ).toEqual([]);
    expect(readImageSettings("nuxt.config.ts", `domains: ["images.harbour-lane.example"]`)).toEqual(
      [],
    );
  });

  it("Netlify: an unanchored expression is unanchored, a match-all is wide, an anchored one is fine", () => {
    const toml = (entry: string) => `[images]\n  remote_images = [${entry}]\n`;
    expect(
      readImageSettings("netlify.toml", toml(`"https://images\\\\.harbour-lane\\\\.example/.*"`)),
    ).toEqual([expect.objectContaining({ kind: "unanchored", line: 2 })]);
    expect(readImageSettings("netlify.toml", toml(`"^https://.*$"`))).toEqual([
      expect.objectContaining({ kind: "wide" }),
    ]);
    expect(
      readImageSettings("netlify.toml", toml(`"^https://images\\\\.harbour-lane\\\\.example/.*$"`)),
    ).toEqual([]);
  });

  it("evidence names the entry, cut to one short line", () => {
    const [issue] = readImageSettings(
      "next.config.js",
      next(`      { protocol: "https", hostname: "**" },`),
    );
    expect(issue?.entry).toContain('hostname: "**"');
    expect(issue?.entry.length).toBeLessThanOrEqual(80);
  });

  it("an empty or unrelated file gives nothing", () => {
    expect(readImageSettings("next.config.js", "")).toEqual([]);
    expect(readImageSettings("next.config.js", "export default {};")).toEqual([]);
  });
});

describe("probeRefusal: unit", () => {
  const ctx = { siteHost: "harbour-lane.example", seenHosts: ["images.harbour-lane.example"] };
  const refused = (url: string, extra: { settingsText?: string } = {}) =>
    probeRefusal(url, { ...ctx, ...extra });

  it("accepts an https address on another named host", () => {
    expect(refused("https://photos.example-gallery.test/probe.png")).toBeUndefined();
  });

  it.each([
    ["http://photos.example-gallery.test/p.png", "https"],
    ["https://127.0.0.1/p.png", "IP address"],
    ["https://169.254.169.254/latest/meta-data", "IP address"],
    ["https://[::1]/p.png", "IP address"],
    ["https://harbour-lane.example/p.png", "own host"],
    ["https://images.harbour-lane.example/p.png", "already"],
    ["not a url", "address"],
    ["https://printer.local/p.png", "private"],
  ])("refuses %s", (url, word) => {
    expect(refused(url)).toContain(word);
  });

  it("refuses a host the given settings name", () => {
    expect(
      refused("https://photos.example-gallery.test/p.png", {
        settingsText: 'hostname: "photos.example-gallery.test"',
      }),
    ).toContain("settings");
  });
});

describe("buildProbe: unit", () => {
  const probe = "https://photos.example-gallery.test/probe.png";
  const address = (query: string) => findOptimizerAddresses(pageWith(`<img src="${query}">`))[0];

  it("keeps the width and quality the page itself used", () => {
    const a = address("/_next/image?url=%2Fa.jpg&w=640&q=75");
    expect(a && buildProbe(ORIGIN, a, probe)).toBe(
      `${ORIGIN}/_next/image?url=${encodeURIComponent(probe)}&w=640&q=75`,
    );
  });

  it("Astro takes href, and no quality it was not given", () => {
    const a = address("/_image?href=%2Fa.png&w=300");
    expect(a && buildProbe(ORIGIN, a, probe)).toBe(
      `${ORIGIN}/_image?href=${encodeURIComponent(probe)}&w=300`,
    );
  });

  it("IPX keeps the page's modifiers and encodes the source", () => {
    const a = address("/_ipx/w_320,f_webp/%2Fa.png");
    expect(a && buildProbe(ORIGIN, a, probe)).toBe(
      `${ORIGIN}/_ipx/w_320,f_webp/${encodeURIComponent(probe)}`,
    );
  });

  it("does not guess a width: an address with none gives no probe", () => {
    const a = address("/_next/image?url=%2Fa.jpg");
    expect(a && buildProbe(ORIGIN, a, probe)).toBeUndefined();
  });
});

describe("sniffImage: unit", () => {
  const bytes = (...n: number[]) => new Uint8Array(n);
  it("knows the common image signatures", () => {
    expect(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image");
    expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image");
    expect(sniffImage(Buffer.from("GIF89a...."))).toBe("image");
    expect(sniffImage(Buffer.from("RIFF\u0001\u0000\u0000\u0000WEBPVP8 "))).toBe("image");
    expect(sniffImage(Buffer.from("\u0000\u0000\u0000\u001cftypavif"))).toBe("image");
  });
  it("tells a web page, other bytes and nothing", () => {
    expect(sniffImage(Buffer.from("<!doctype html><html>"))).toBe("html");
    expect(sniffImage(Buffer.from("%PDF-1.7"))).toBe("other");
    expect(sniffImage(new Uint8Array())).toBe("empty");
  });
});

describe("imagesConfigSchema: unit", () => {
  it("takes a probe address and up to six settings files", () => {
    expect(
      imagesConfigSchema.safeParse({
        imageOptimizerProbeUrl: "https://photos.example-gallery.test/p.png",
        settingsFiles: ["next.config.js"],
      }).success,
    ).toBe(true);
  });
  it("refuses an unknown key, a bad address and a seventh file", () => {
    expect(imagesConfigSchema.safeParse({ probeUrl: "x" }).success).toBe(false);
    expect(imagesConfigSchema.safeParse({ imageOptimizerProbeUrl: "nope" }).success).toBe(false);
    expect(
      imagesConfigSchema.safeParse({ settingsFiles: ["a", "b", "c", "d", "e", "f", "g"] }).success,
    ).toBe(false);
  });
});
