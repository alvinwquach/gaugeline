import { advisoriesFor } from "../libraries/advisories.js";
import type { Detection } from "../libraries/detect.js";
import { LIBRARY_SCRIPT_CAP } from "../libraries/reader.js";
import type { CheckContext, Finding } from "../model.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { escapeInvisible } from "./hidden-text/escape.js";

const clip = (text: string): string => escapeInvisible(text, 120);

/** The most advisories one finding lists; the rest are counted. */
const LISTED = 10;

/** A script as a finding names it: its address with no query or fragment (a query may hold a key). */
function labelOf(url: string): string {
  try {
    const u = new URL(url);
    return clip(`${u.origin}${u.pathname}`);
  } catch {
    return clip(url);
  }
}

const fileOf = (label: string): string => label.slice(label.lastIndexOf("/") + 1);

const HOW: Record<Detection["evidence"]["how"], string> = {
  banner: "the file's banner comment",
  "version-string": "a version string in the file",
  "file-name": "the script's address",
  name: "the file's license line",
};

/** The http and https script addresses a page names, each once, in document order. */
function scriptUrls(page: PageSnapshot): string[] {
  const seen = new Set<string>();
  for (const s of page.scripts) if (/^https?:\/\//i.test(s)) seen.add(s);
  return [...seen];
}

export const libraryWithAdvisory = defineCheck<PageSnapshot>({
  id: "library-with-advisory",
  size: "M",
  done: "The libraries the finding names are on versions past the fixes the advisories list, or the client has decided with the developer who knows the theme that they stay; running Gaugeline again shows the versions served.",
  estimateChanges:
    "An hour for a library the theme loads from a file you can swap. A day or more when the library is bundled into an old theme or plugin and the code that uses it has to be tested on the newer version.",
  area: "Security & email",
  severity: "medium",
  title: "A JavaScript library the site serves has a published advisory",
  what: "Gaugeline reads the JavaScript files a page loads, finds the version of jQuery, jQuery UI, Lodash, Moment.js, Bootstrap or AngularJS in them, and lists the published advisories that name that version, with the version that fixes each.",
  why: "Libraries in an old theme or plugin stay at the version they were installed at, and advisories are published about versions long after. This is a list of facts: which version is served and which advisories name it. Whether an advisory matters for this site depends on how the site uses the library, which Gaugeline cannot see, and it does not say.",
  fix: "Look at where the file comes from: the theme, a plugin, a package in the project or a CDN address. Update it to a version past the fixes the finding lists, or take the library out when nothing uses it, then test the pages that use it. If it is bundled into code you cannot change, tell the client who maintains it.",
  tech: "Only with --libraries. The script files the page's own HTML names (script src, same site or another, at most 20, each fetched once with GET, never any address the page does not name) are read as text and never run; the first 2 MiB of each is searched. The version comes from a banner comment, a version string in the code or the file name and path of the address (for example /jquery/1.12.4/ or lodash@4.17.21), the file's own text first. It is compared with packages/core/src/data/library-advisories.json: for each advisory, the affected versions and the page that publishes it, with a verified flag that is false until someone has compared the entry with its page. A finding shows the library, its version, the script's address (with no query), and each advisory with its id, a short description and the fixed-in version, never script text beyond the version. A library recognised by name with no version, a script that cannot be read or is longer than what is read, and minified files with no library name or version are could-not-check. A library bundled into one minified file with its banner removed is not seen. The same files give the same findings",
  async run(page, ctx: CheckContext) {
    const libraries = ctx.libraries;
    if (!libraries) return [];
    const urls = scriptUrls(page);
    const out: Finding[] = [];
    const unidentified: string[] = [];
    for (const url of urls.slice(0, LIBRARY_SCRIPT_CAP)) {
      const read = await libraries.read(url);
      const label = labelOf(url);
      if (!read.ok) {
        ctx.couldNotCheck?.(
          page.finalUrl,
          `The script ${label} ${clip(read.reason)}, so it was not compared with the advisories.`,
        );
        continue;
      }
      if (read.truncated)
        ctx.couldNotCheck?.(
          page.finalUrl,
          `The script ${label} is longer than Gaugeline reads, so only its start was searched.`,
        );
      if (read.detections.length === 0 && read.minified) unidentified.push(fileOf(label));
      for (const d of read.detections) {
        if (d.version === null) {
          ctx.couldNotCheck?.(
            page.finalUrl,
            `${d.name} is served from ${label}, but neither the file nor its address says which version, so it was not compared with the advisories.`,
          );
          continue;
        }
        const matches = advisoriesFor(d.library, d.version);
        if (matches.length === 0) continue;
        const listed = matches
          .slice(0, LISTED)
          .map(
            (m) =>
              `${m.advisory.id} (${m.advisory.summary}; ${m.fixedIn === null ? "no fixed version listed" : `fixed in ${m.fixedIn}`})`,
          );
        const more = matches.length > LISTED ? ` and ${matches.length - LISTED} more` : "";
        out.push({
          checkId: "library-with-advisory",
          severity: "medium",
          title: this.title,
          evidence: `${d.name} ${clip(d.version)} is served from ${label} (version read from ${HOW[d.evidence.how]}). ${matches.length} published ${matches.length === 1 ? "advisory names" : "advisories name"} versions that include it: ${listed.join(", ")}${more}`,
          url: clip(page.finalUrl),
        });
      }
    }
    if (unidentified.length > 0) {
      const names = unidentified.slice(0, 3).join(", ");
      const rest = unidentified.length > 3 ? ` and ${unidentified.length - 3} more` : "";
      const one = unidentified.length === 1;
      ctx.couldNotCheck?.(
        page.finalUrl,
        `${unidentified.length} minified JavaScript ${one ? "file carries" : "files carry"} no library name or version (${names}${rest}), so what ${one ? "it contains" : "they contain"} was not compared with the advisories.`,
      );
    }
    if (urls.length > LIBRARY_SCRIPT_CAP)
      ctx.couldNotCheck?.(
        page.finalUrl,
        `${urls.length - LIBRARY_SCRIPT_CAP} JavaScript files were not read: at most ${LIBRARY_SCRIPT_CAP} are read for one page.`,
      );
    return out;
  },
});

export const LIBRARY_CHECKS = [libraryWithAdvisory] as const;
