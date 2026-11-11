import { FetchError, type Fetcher } from "../fetcher.js";
import { inKind } from "../request-log.js";
import { isSameSite } from "../sample.js";
import { detect, looksMinified, MAX_SCRIPT_CHARS, type Detection } from "./detect.js";

/** At most this many script files are read for one page. */
export const LIBRARY_SCRIPT_CAP = 20;

/** The most bytes of one script the fetcher is asked to read: the same 2 MiB that is searched. */
export const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;

/** A script file as the library check reads it: what it holds, or why it could not be read. */
export type ScriptReading =
  | {
      ok: true;
      url: string;
      detections: Detection[];
      /** Some line is longer than 1,000 characters. */
      minified: boolean;
      /** The file is longer than what is searched (2 MiB): only its start was. */
      truncated: boolean;
    }
  | { ok: false; url: string; reason: string };

/**
 * What the library check reads, once per address and shared: the script files a page's own HTML names, third-party
 * ones included. Each is a plain GET through the fetcher, at most 2 MiB of it, read as text and matched against
 * fixed patterns, never run. Nothing the page does not name is asked for.
 */
export interface Libraries {
  /**
   * `from` is the page that names the script. A script on another site is read to at most 2 MiB (the fetcher is told
   * to stop there). One on the page's own site is asked for as the secret check asks for it, the same request, so a
   * file of the site's is not asked for twice; the 2 MiB search limit still applies to what is read.
   */
  read(url: string, from?: string): Promise<ScriptReading>;
  /**
   * True the first time an address is asked about in this run, false after. Several pages name the same script
   * (a theme's jQuery is on every page), and its finding and notes are given once, on the first page.
   */
  claim(url: string): boolean;
}

const REFUSED = "refused (private address)";

const refused = (hop: { status: number; error?: string } | undefined): boolean =>
  hop !== undefined && (hop.error === "private-address-refused" || hop.status === 0);

export function createLibraries(fetcher: Fetcher): Libraries {
  const reads = new Map<string, Promise<ScriptReading>>();
  const claimed = new Set<string>();
  const read = async (url: string, capped: boolean): Promise<ScriptReading> => {
    try {
      const last = (
        await inKind("script", () =>
          capped ? fetcher.get(url, { maxBytes: MAX_SCRIPT_BYTES }) : fetcher.get(url),
        )
      ).at(-1);
      if (!last) return { ok: false, url, reason: "gave no answer" };
      if (refused(last)) return { ok: false, url, reason: REFUSED };
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
      if (
        err instanceof FetchError &&
        (err.reason === "private-address-refused" || err.reason === "blocked-address")
      )
        return { ok: false, url, reason: REFUSED };
      return {
        ok: false,
        url,
        reason: `could not be read: ${(err instanceof Error ? err.message : "the request failed").replace(/[.\s]+$/, "")}`,
      };
    }
  };
  return {
    read(url, from) {
      let p = reads.get(url);
      if (!p) reads.set(url, (p = read(url, from === undefined || !isSameSite(url, from))));
      return p;
    },
    claim(url) {
      if (claimed.has(url)) return false;
      claimed.add(url);
      return true;
    },
  };
}
