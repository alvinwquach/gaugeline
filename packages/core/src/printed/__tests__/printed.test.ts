import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { zlibSync } from "fflate";
import { describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher, FetchError, type Fetcher, type Hop } from "../../fetcher.js";
import { byAddress, checkPrinted, classifyPrinted } from "../check.js";
import { decodePng, PngError } from "../png.js";
import { readQr } from "../qr.js";
import { readRegister, registerAdditions } from "../register.js";

const FIXTURES = fileURLToPath(new URL("../../../../fixtures/", import.meta.url));
const REGISTER = readFileSync(`${FIXTURES}printed/register.csv`, "utf8");

const hop = (url: string, status: number, location?: string, body = ""): Hop => ({
  url,
  status,
  headers: location ? { location } : { "content-type": "text/html" },
  body,
  ms: 1,
});
/** A fetcher answering each address from a table of hop lists, or throwing for "down". */
function fake(trails: Record<string, Hop[] | "down">): Fetcher & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    get: async (url: string) => {
      asked.push(url);
      const t = trails[url];
      if (t === undefined || t === "down")
        throw new FetchError("refused", `${new URL(url).host} refused the connection.`, url, []);
      return t;
    },
    getSite: async () => [],
    stats: { requests: 0, maxInFlight: 0 },
  };
}

/** A PNG built here, with fflate: one IHDR, one IDAT (filter 0 rows), an optional PLTE. */
function png(
  width: number,
  height: number,
  type: number,
  depth: number,
  rows: number[][],
  plte?: number[],
) {
  const chunk = (name: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length);
    new DataView(out.buffer).setUint32(0, body.length);
    out.set(
      [...name].map((c) => c.charCodeAt(0)),
      4,
    );
    out.set(body, 8);
    return out; // CRC is not checked by the reader
  };
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr.set([depth, type, 0, 0, 0], 8);
  const raw = Uint8Array.from(rows.flatMap((r) => [0, ...r]));
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    ...(plte ? [chunk("PLTE", Uint8Array.from(plte))] : []),
    chunk("IDAT", zlibSync(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe("printed links: unit", () => {
  it("the register: a BOM, a quoted comma, optional columns, and the file's line numbers", () => {
    const rows = readRegister(REGISTER);
    expect(rows).toHaveLength(6);
    expect(rows[2]).toEqual({
      line: 4,
      url: "http://copperkettle.example/spring-flyer",
      where: "flyers, spring 2026",
      printedOn: "2026-04-02",
    });
    expect(rows[0]?.expectedDestination).toBe("http://copperkettle.example/menu");
    expect(() => readRegister("where,date\nflyer,2026\n")).toThrow(
      "The printed register has no url column. Headers: where, date.",
    );
    expect(readRegister("Printed URL,Location\nhttps://x.example/a,menu\n")[0]).toEqual({
      line: 2,
      url: "https://x.example/a",
      where: "menu",
    });
  });

  it("QR decoding: the two sharp fixture images read, the blurred one is could-not-check", () => {
    expect(readQr(readFileSync(`${FIXTURES}qr/table-tent.png`))).toEqual({
      ok: true,
      text: "https://copperkettle.example/table-menu?utm_source=table-tent&utm_medium=qr",
    });
    expect(readQr(readFileSync(`${FIXTURES}qr/spring-flyer.png`))).toEqual({
      ok: true,
      text: "https://copperkettle.example/spring-flyer",
    });
    expect(readQr(readFileSync(`${FIXTURES}qr/blurred-flyer.png`))).toEqual({
      ok: false,
      reason: "no QR code could be read (blurred, too small, or not there)",
    });
    expect(readQr(new TextEncoder().encode("not an image"))).toEqual({
      ok: false,
      reason: "the image couldn't be read: not a PNG file",
    });
  });

  it("the PNG reader: greyscale, a 1-bit palette, and a refusal for interlaced images", () => {
    const grey = decodePng(png(2, 1, 0, 8, [[0, 255]]));
    expect([...grey.data]).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
    const pal = decodePng(png(3, 1, 3, 1, [[0b10100000]], [10, 20, 30, 200, 210, 220]));
    expect([...pal.data]).toEqual([200, 210, 220, 255, 10, 20, 30, 255, 200, 210, 220, 255]);
    const interlaced = png(1, 1, 0, 8, [[0]]);
    interlaced[8 + 8 + 12] = 1; // IHDR's interlace byte
    expect(() => decodePng(interlaced)).toThrow(PngError);
  });

  it("classify: dead, to home, tags lost, a chain of three, the expected destination", () => {
    const at = (p: string) => `https://k.example${p}`;
    const ids = (hops: Hop[], printed: string, expected?: string) =>
      classifyPrinted(hops, printed, "flyer", expected ? { expected } : {}).ids;
    expect(ids([hop(at("/a"), 301, "/gone"), hop(at("/gone"), 404)], at("/a"))).toEqual([
      "printed-dead",
    ]);
    expect(ids([hop(at("/a"), 301, "/"), hop(at("/"), 200)], at("/a"))).toEqual([
      "printed-to-home",
    ]);
    expect(ids([hop(at("/a"), 301, "/"), hop(at("/"), 200)], at("/a"), at("/menu"))).toEqual([
      "printed-wrong-destination",
    ]);
    expect(
      ids(
        [hop(at("/a?utm_source=x&id=2"), 301, "/b?id=2"), hop(at("/b?id=2"), 200)],
        at("/a?utm_source=x&id=2"),
      ),
    ).toEqual(["printed-tags-lost"]);
    expect(
      ids(
        [
          hop(at("/a"), 301, "/b"),
          hop(at("/b"), 301, "/c"),
          hop(at("/c"), 301, "/d"),
          hop(at("/d"), 200),
        ],
        at("/a"),
        at("/d"),
      ),
    ).toEqual(["printed-chain"]);
    expect(
      ids(
        [hop(at("/a"), 301, "/b"), hop(at("/b"), 301, "/c"), hop(at("/c"), 200)],
        at("/a"),
        at("/c"),
      ),
    ).toEqual([]);
    expect(
      classifyPrinted([hop(at("/a"), 301, "/"), hop(at("/"), 200)], at("/a"), "the table tents")
        .evidence,
    ).toEqual({
      "printed-to-home":
        "the table tents: https://k.example/a now lands on the home page (k.example/)",
    });
  });

  it("registerAdditions: new decoded addresses only, in the register's own columns", () => {
    expect(
      registerAdditions("url,where,printedOn\nhttps://a.example/x,menu,2026\n", [
        { url: "https://a.example/x", where: "menu.png" },
        { url: "https://a.example/y?a=1,2", where: "flyer.png" },
      ]),
    ).toBe('"https://a.example/y?a=1,2",flyer.png,\n');
  });
});

describe("printed links: integration (the Copper Kettle register against its fixture)", () => {
  it("six rows, five addresses: one dead, one to home, one tags lost; /menu once, with both places", async () => {
    const site = await startFixture("printed-links");
    try {
      const out = await checkPrinted(readRegister(REGISTER), {
        fetcher: createFetcher({ hosts: site.hosts }),
        file: "register.csv",
      });
      expect(out.findings.map((f) => [f.checkId, f.group?.lines])).toEqual([
        ["printed-dead", [4]],
        ["printed-tags-lost", [3]],
        ["printed-to-home", [5]],
      ]);
      expect(out.findings[0]?.evidence).toBe(
        "flyers, spring 2026: http://copperkettle.example/spring-flyer ends in 404 at copperkettle.example/spring-flyer",
      );
      expect(out.findings[1]?.evidence).toBe(
        "table tents: http://copperkettle.example/table-menu?utm_source=table-tent&utm_medium=qr arrives at copperkettle.example/menu without utm_source, utm_medium",
      );
      expect(out.checked).toBe(5);
      expect(site.hits.get("/menu")).toBe(2); // the /menu row once, and /table-menu's redirect
      expect([...site.methods.keys()]).toEqual(["GET"]);
    } finally {
      await site.close();
    }
  });
});

describe("printed links: edge cases", () => {
  it("a short link that shows its own page before the destination (an interstitial) is the wrong destination", async () => {
    const short = "https://lnk.example/kettle";
    const out = await checkPrinted([{ line: 2, url: short, where: "beer mats" }], {
      fetcher: fake({
        [short]: [
          hop(
            short,
            200,
            undefined,
            '<meta http-equiv="refresh" content="3; url=https://k.example/menu">',
          ),
        ],
      }),
    });
    expect(out.findings.map((f) => [f.checkId, f.evidence])).toEqual([
      [
        "printed-wrong-destination",
        "beer mats: https://lnk.example/kettle stops on a page of its own that sends people on with a meta refresh (an interstitial), instead of redirecting",
      ],
    ]);
  });

  it("printed as http://, and the site now answers only on https: dead, with what to do", async () => {
    const http = "http://k.example/menu";
    const out = await checkPrinted([{ line: 2, url: http, where: "menu boards" }], {
      fetcher: fake({
        [http]: "down",
        "https://k.example/menu": [hop("https://k.example/menu", 200)],
      }),
    });
    expect(out.findings.map((f) => f.evidence)).toEqual([
      "menu boards: http://k.example/menu doesn't answer on http, the address on the print; https does. Answer on http and redirect to https",
    ]);
    // Neither answers: could not check, not a finding.
    const none = await checkPrinted([{ line: 2, url: http, where: "menu boards" }], {
      fetcher: fake({}),
    });
    expect([none.findings, none.couldNotCheck.map((c) => c.lines)]).toEqual([[], [[2]]]);
  });

  it("the same URL on two flyers: requested once, reported with every place", async () => {
    const url = "https://k.example/gone";
    const rows = [
      { line: 2, url, where: "spring flyer" },
      { line: 5, url: "https://k.example/gone", where: "summer flyer" },
    ];
    expect([...byAddress(rows).values()].map((g) => g.length)).toEqual([2]);
    const f = fake({ [url]: [hop(url, 404)] });
    const out = await checkPrinted(rows, { fetcher: f });
    expect(f.asked).toEqual([url]);
    expect(out.findings.map((x) => [x.group?.lines, x.evidence])).toEqual([
      [[2, 5], "spring flyer, summer flyer: https://k.example/gone ends in 404 at k.example/gone"],
    ]);
  });
});
