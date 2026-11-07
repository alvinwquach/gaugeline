/**
 * An invented crawler export for the Fern and Kiln studio (fernkiln.example): 4,180 rows filed
 * under one audit issue, "Orphan URLs", of which 4,061 are Next.js prefetch payloads (?_rsc=) for
 * 40 pages. Generated, not committed: the same text every time, so the docs can quote its summary.
 */
const POTS = [
  "celadon-tea-bowl",
  "speckled-mug",
  "ash-glaze-jug",
  "tenmoku-bowl",
  "shino-vase",
  "salt-glaze-bottle",
  "moon-jar",
  "nesting-bowls",
  "butter-dish",
  "olive-dish",
  "serving-platter",
  "bud-vase",
];
/** The 40 pages behind the export. */
export const CRAWL_EXPORT_PAGES: readonly string[] = [
  "/",
  "/about",
  "/shop",
  "/glazes",
  "/classes",
  "/gift-cards",
  "/contact",
  "/press",
  "/privacy",
  "/terms",
  "/journal",
  ...POTS.map((p) => `/shop/${p}`),
  ...Array.from({ length: 17 }, (_, i) => `/journal/firing-notes-${i + 1}`),
];

/** A short, fixed hex string per row: what a build hash looks like, without a random source. */
const hash = (i: number) => ((i * 2654435761) >>> 0).toString(16).padStart(8, "0").slice(0, 5);

/** The export, its addresses on `origin` (default the invented https://fernkiln.example). */
export function crawlExport(origin = "https://fernkiln.example"): string {
  const HOST = origin;
  const rows: [string, string, string][] = [];
  const pages = CRAWL_EXPORT_PAGES;
  // 4,061 prefetch payloads, spread over the 40 pages.
  for (let i = 0; i < 4061; i++) {
    const page = pages[i % pages.length] ?? "/";
    rows.push([`${HOST}${page}?_rsc=${hash(i)}`, "text/x-component", "200"]);
  }
  // 70 assets: build chunks and images.
  for (let i = 0; i < 35; i++)
    rows.push([
      `${HOST}/_next/static/chunks/${hash(i + 9000)}.js`,
      "application/javascript",
      "200",
    ]);
  for (let i = 0; i < 35; i++)
    rows.push([
      `${HOST}/images/pots/${POTS[i % POTS.length] ?? ""}-${i}.webp`,
      "image/webp",
      "200",
    ]);
  // 15 data routes: the shop's stock API.
  for (let i = 0; i < 15; i++)
    rows.push([`${HOST}/api/stock?sku=FK-${100 + i}`, "application/json", "200"]);
  // 34 ordinary page rows, some spelt with an upper-case host or a trailing slash.
  for (let i = 0; i < 34; i++) {
    const page = pages[i] ?? "/";
    const spelt =
      i % 5 === 1 ? `${HOST.replace(/fernkiln/, "FERNKILN")}${page}/` : `${HOST}${page}`;
    rows.push([spelt, "text/html; charset=utf-8", "200"]);
  }
  // Interleave by a fixed stride, as a crawler's export order would mix them.
  const out: [string, string, string][] = [];
  const stride = 97;
  for (let k = 0, j = 0; k < rows.length; k++, j = (j + stride) % rows.length)
    out.push(rows[j] as [string, string, string]);
  const cell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [
    "Address,Content Type,Status Code,Issue",
    ...out.map(([a, t, s]) => [a, t, s, "Orphan URLs"].map(cell).join(",")),
    "",
  ].join("\n");
}
