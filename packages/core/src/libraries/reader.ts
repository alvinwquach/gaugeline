import type { Fetcher } from "../fetcher.js";
import { inKind } from "../request-log.js";
import { detect, looksMinified, MAX_SCRIPT_CHARS, type Detection } from "./detect.js";

/** At most this many script files are read for one page. */
export const LIBRARY_SCRIPT_CAP = 20;

/** A script file as the library check reads it: what it holds, or why it could not be read. */
export type ScriptReading =
  | {
      ok: true;
      url: string;
      detections: Detection[];
      /** Some line is longer than 1,000 characters. */
      minified: boolean;
      /** The file is longer than what is searched (2 MiB), or longer than the fetcher reads: only its start was. */
      truncated: boolean;
    }
  | { ok: false; url: string; reason: string };

/**
 * What the library check reads, once per address and shared: the script files a page's own HTML names, third-party
 * ones included. Each is a plain GET through the fetcher, read as text and matched against fixed patterns, never run.
 * Nothing the page does not name is asked for.
 */
export interface Libraries {
  read(url: string): Promise<ScriptReading>;
}

export function createLibraries(fetcher: Fetcher): Libraries {
  const reads = new Map<string, Promise<ScriptReading>>();
  const read = async (url: string): Promise<ScriptReading> => {
    try {
      const last = (await inKind("script", () => fetcher.get(url))).at(-1);
      if (!last) return { ok: false, url, reason: "gave no answer" };
      if (last.status < 200 || last.status >= 300)
        return { ok: false, url, reason: `answered ${last.status}` };
      const body = last.body ?? "";
      const cut = body.length > MAX_SCRIPT_CHARS;
      const text = cut ? body.slice(0, MAX_SCRIPT_CHARS) : body;
      return {
        ok: true,
        url,
        detections: detect(text, url),
        minified: looksMinified(text),
        truncated: cut || last.truncated === true,
      };
    } catch (err) {
      return {
        ok: false,
        url,
        reason: `could not be read: ${(err instanceof Error ? err.message : "the request failed").replace(/[.\s]+$/, "")}`,
      };
    }
  };
  return {
    read(url) {
      let p = reads.get(url);
      if (!p) reads.set(url, (p = read(url)));
      return p;
    },
  };
}
