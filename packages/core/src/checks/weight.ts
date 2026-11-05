import { load } from "cheerio/slim";

/** Thresholds, named so the checks reference states them once. Bytes of the UTF-8 body. */
export const HTML_HUGE_BYTES = 2 * 1024 * 1024;
export const INLINE_DATA_HEAVY_BYTES = 300 * 1024;
export const PAGE_HEAVY_BYTES = 3 * 1024 * 1024;

export interface PageMeasure {
  htmlBytes: number;
  /** Inline script elements that carry data, not code: JSON types, __NEXT_DATA__, framework payloads. */
  inlineDataBytes: number;
  scriptCount: number;
}

const DATA_TYPE = /^application\/(?:[\w.+-]+\+)?json$/i;
const DATA_START =
  /^\s*(?:self\.__next_f\.push\(|\(self\.__next_f\s*=|window\.__(?:NUXT|APOLLO_STATE|INITIAL_STATE|PRELOADED_STATE)__\s*=)/;

/** One script element's text as data, or not: by type, by id, or by a known payload opener. */
function isData(type: string | undefined, id: string | undefined, text: string): boolean {
  if (type && DATA_TYPE.test(type.split(";")[0]?.trim() ?? "")) return true;
  if (id === "__NEXT_DATA__") return true;
  return DATA_START.test(text);
}

/** Sizes are Buffer.byteLength of the UTF-8 text, so 1,000 emoji count as 4,000 bytes. */
export function measurePage(html: string): PageMeasure {
  const $ = load(html);
  let inlineDataBytes = 0;
  const scripts = $("script");
  scripts.each((_, el) => {
    if ($(el).attr("src") !== undefined) return;
    const text = $(el).text();
    if (isData($(el).attr("type"), $(el).attr("id"), text))
      inlineDataBytes += Buffer.byteLength(text, "utf8");
  });
  return {
    htmlBytes: Buffer.byteLength(html, "utf8"),
    inlineDataBytes,
    scriptCount: scripts.length,
  };
}

/** "2.5 MB", or "over 5 MB" when the body was cut at the fetcher's cap. */
export function describeSize(bytes: number, truncated = false): string {
  const mb = bytes / (1024 * 1024);
  if (truncated) return `over ${Math.round(mb)} MB`;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}
