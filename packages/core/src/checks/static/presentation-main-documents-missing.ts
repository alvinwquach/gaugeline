import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import {
  depthMap,
  importsOf,
  lineOf,
  matching,
  notReadReason,
  scrub,
  sortFindings,
  sourcePathsOf,
} from "./scan.js";

/**
 * FF-29 (advice): Sanity's Presentation tool (visual editing) is set up with `presentationTool({ ... })`
 * and no `resolve.mainDocuments`, so no route of the site is mapped to the document it shows and the
 * editor cannot open that document from the preview. Looked at: a call of `presentationTool` in a file
 * that imports it from `sanity/presentation` or `@sanity/presentation`, whose options are written in
 * the call. No `resolve` option, a `resolve` with no `mainDocuments`, or an empty `mainDocuments` list is
 * a finding; options, a `resolve` or a spread that Gaugeline cannot read in the call is could-not-check.
 * It does not compare the routes with the site's pages. Static: it reads the code and runs none of it.
 *
 * // [docs] sanity@6.23.0 > PresentationPluginOptions - https://raw.githubusercontent.com/sanity-io/sanity/main/packages/sanity/src/presentation/types.ts (read on main, the 6.23.0 tag was not read): the options have `resolve?: { mainDocuments?: DocumentResolver[]; locations?: ... }`, and a DocumentResolver maps a `route` to a document by `type`, a `filter` or a `resolve` function
 * // [GC] no source found (uncited): that without mainDocuments the editor sees "Missing a main document". Sanity's page was unreachable and the Presentation README does not describe resolve; the check text says what the configuration lacks, not what the editor sees.
 */
const ID = "presentation-main-documents-missing";

const PRESENTATION_PACKAGES = new Set(["sanity/presentation", "@sanity/presentation"]);

/** The index of the first top-level property called `key` in the object at `open..close`, or -1. */
function topLevelKey(
  bare: string,
  depth: Int32Array,
  open: number,
  close: number,
  key: string,
): number {
  const inner = depth[open + 1] ?? 0;
  const re = new RegExp(`(?<![\\w$.])${key}\\b`, "g");
  re.lastIndex = open + 1;
  for (let m = re.exec(bare); m !== null && m.index < close; m = re.exec(bare))
    if ((depth[m.index] ?? 0) === inner) return m.index;
  return -1;
}

export const presentationMainDocumentsMissing = defineCheck<LocalSourceInput>({
  id: ID,
  size: "S",
  done: "The Presentation tool's resolve option lists mainDocuments: each route of the site that shows a document maps to it.",
  estimateChanges:
    "A few lines per kind of page with defineDocuments: a route and a type or a filter. More if the site has many kinds of page.",
  area: "Launch day",
  severity: "low",
  title: "Visual editing is set up with no route mapped to a document",
  what: "The Presentation tool is configured with no resolve.mainDocuments (no resolve option, a resolve with only locations, or an empty list), so no route of the site is mapped to the document it shows.",
  why: "Presentation can open the document behind a page only when it is told which route shows which document. Without that mapping an editor looking at a page in the preview cannot jump to the document to edit it. (Gaugeline has not confirmed from Sanity's documentation the message the editor sees.)",
  fix: "Add resolve.mainDocuments to presentationTool, with defineDocuments: for each kind of page, its route (/menu/:slug) and the type or GROQ filter of the document it shows. Add locations as well if editors should see where a document is used.",
  tech: "reads the code files of the folder named, never runs them; a call of presentationTool in a file that imports it from sanity/presentation or @sanity/presentation, with its options written in the call, and no resolve option, a resolve object with no mainDocuments, or an empty mainDocuments list, is a finding at the call; options that are not written in the call, a spread, or a resolve that is not an object written in the call is could-not-check; the routes are not compared with the site's pages; no source file read, or some left out, is could-not-check; the finding names the file and the line, never a route or a project id",
  run(input, ctx) {
    const { tree } = input;
    const url = `source:${tree.label}`;
    const findings: Finding[] = [];
    const unsure: string[] = [];
    for (const file of sourcePathsOf(tree)) {
      const text = tree.files.get(file) ?? "";
      const code = scrub(text, false);
      if (!importsOf(code).some((i) => PRESENTATION_PACKAGES.has(i.spec))) continue;
      const bare = scrub(text, true);
      const depth = depthMap(bare);
      for (const call of bare.matchAll(/(?<![\w$.])presentationTool\s*\(/g)) {
        const parenOpen = call.index + call[0].length - 1;
        const parenClose = matching(bare, parenOpen);
        const line = lineOf(bare, call.index);
        const open = bare.indexOf("{", parenOpen);
        if (
          parenClose < 0 ||
          open < 0 ||
          open > parenClose ||
          bare.slice(parenOpen + 1, open).trim() !== ""
        ) {
          unsure.push(`${file}:${line}`);
          continue;
        }
        const close = matching(bare, open);
        const found = (what: string): void => {
          findings.push({
            checkId: ID,
            severity: "low",
            title: this.title,
            evidence: `${file}:${line}: presentationTool ${what}, so no route is mapped to a document.`,
            url,
            source: { file, line },
          });
        };
        const at = topLevelKey(bare, depth, open, close, "resolve");
        if (at < 0) {
          if (/\.\.\./.test(bare.slice(open, close).replace(/\{[^{}]*\}/g, "")))
            unsure.push(`${file}:${line}`);
          else found("has no resolve option");
          continue;
        }
        const valueAt = /^\s*:\s*/.exec(bare.slice(at + "resolve".length));
        const objOpen = valueAt === null ? -1 : at + "resolve".length + valueAt[0].length;
        if (objOpen < 0 || bare[objOpen] !== "{") {
          unsure.push(`${file}:${line}`);
          continue;
        }
        const objClose = matching(bare, objOpen);
        const docs = topLevelKey(bare, depth, objOpen, objClose, "mainDocuments");
        if (docs < 0) {
          if (/\.\.\./.test(bare.slice(objOpen, objClose).replace(/\{[^{}]*\}/g, "")))
            unsure.push(`${file}:${line}`);
          else found("has no resolve.mainDocuments");
        } else if (/^\s*:\s*\[\s*\]/.test(bare.slice(docs + "mainDocuments".length))) {
          found("has an empty resolve.mainDocuments");
        }
      }
    }
    sortFindings(findings);
    if (unsure.length > 0)
      ctx.couldNotCheck?.(
        url,
        `${unsure.join(", ")}: the Presentation tool's options are not written in the call, so Gaugeline cannot tell whether routes are mapped to documents`,
      );
    if (findings.length === 0 && unsure.length === 0) {
      const why = notReadReason(tree);
      if (why !== undefined) ctx.couldNotCheck?.(url, why);
    }
    return findings;
  },
});
