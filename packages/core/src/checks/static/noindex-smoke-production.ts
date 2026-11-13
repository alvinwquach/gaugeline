import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import { lineOf } from "./scan.js";

/**
 * FF-06. CI workflow files (`.github/workflows/*.yml`) are read as text. A workflow "has a noindex
 * smoke test" when it mentions noindex or X-Robots-Tag; it targets previews when it says preview or
 * runs on pull requests, and production when it says production or runs on the main branch. The
 * rule is on the whole set of workflows: a preview test is a finding only when no workflow with a
 * noindex test says anything about production. No YAML is parsed and nothing is run.
 *
 * // [GC] no source found (uncited): the GitHub Actions trigger and environment names were not read from the official pages; the check looks for the words in the files and claims no more.
 */
const ID = "noindex-smoke-production";
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const SMOKE = /noindex|x-robots-tag/i;
const PREVIEW = /\bpreview\b|pull_request|deployment_status/i;
const PRODUCTION =
  /\bproduction\b|\bprod\b|refs\/heads\/(?:main|master)|branches:\s*\[?\s*["']?(?:main|master)\b/i;

export const noindexSmokeProduction = defineCheck<LocalSourceInput>({
  id: ID,
  size: "S",
  done: "The CI workflows check the indexing setting on the production deployment as well as on previews.",
  estimateChanges:
    "Usually one more step or trigger beside the preview test. If production is deployed outside CI, the check has to be run by whatever deploys it.",
  area: "Search & sharing",
  severity: "medium",
  title: "The noindex smoke test runs on previews but not on production",
  what: "A CI workflow checks noindex (or X-Robots-Tag) on preview deployments, and no workflow does the same for production.",
  why: "Production is where indexing matters. A test that only watches previews proves the preview is hidden; it says nothing about the live site, so a setting changed at launch (or one that never changed) goes unnoticed.",
  fix: "Run the same test against the production deployment after each production deploy (a workflow on the main branch, or a deployment_status trigger for the Production environment). Expect the opposite there once the site is live: no noindex.",
  tech: "static, reads .github/workflows files as text (comments are skipped) and makes no request; a workflow has the test when it mentions noindex or x-robots-tag; it targets previews when it says preview or runs on pull_request or deployment_status, and production when it says production or prod or runs on main or master; a finding when a workflow tests previews and no workflow with the test says anything about production; a workflow with the test and neither word, no workflow files, or a workflow file that could not be read is not sure; no test at all passes",
  run(input, ctx) {
    const { tree } = input;
    const url = `source:${tree.label}`;
    const files = [...tree.files.keys()].filter((p) => WORKFLOW.test(p)).sort();
    const left = [...tree.skipped.keys()].filter((p) => WORKFLOW.test(p));
    if (files.length === 0) {
      ctx.couldNotCheck?.(
        url,
        "no .github/workflows file was read, so what CI checks could not be judged",
      );
      return [];
    }
    let previewFile: { file: string; line: number } | undefined;
    let production = false;
    let unclear: string | undefined;
    for (const file of files) {
      const text = (tree.files.get(file) ?? "").replace(/(^|\s)#[^\n]*/g, "$1");
      const smoke = SMOKE.exec(text);
      if (smoke === null) continue;
      const toPreview = PREVIEW.test(text);
      const toProduction = PRODUCTION.test(text);
      if (toProduction) production = true;
      else if (toPreview) previewFile ??= { file, line: lineOf(text, smoke.index) };
      else
        unclear ??= `${file} checks noindex but does not say whether it runs on previews or on production`;
    }
    if (production) return [];
    if (previewFile !== undefined) {
      if (left.length > 0) {
        ctx.couldNotCheck?.(
          url,
          `${left[0] ?? "a workflow file"} could not be read, and it may test production`,
        );
        return [];
      }
      return [
        {
          checkId: ID,
          severity: "medium",
          title: this.title,
          evidence: `${previewFile.file}:${previewFile.line} tests noindex on previews, and no workflow tests it on production`,
          url,
          source: previewFile,
        } satisfies Finding,
      ];
    }
    if (unclear !== undefined || left.length > 0)
      ctx.couldNotCheck?.(url, unclear ?? `${left[0] ?? "a workflow file"} could not be read`);
    return [];
  },
});
