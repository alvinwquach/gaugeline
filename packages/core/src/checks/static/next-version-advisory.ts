import { defineCheck } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import { runPackageAdvisory } from "./package-advisory.js";

// [docs] GHSA-2464-fhr4-w9xw, GHSA-673q-mjm6-r5xr and GHSA-p3m5-59mp-jv5r - https://github.com/advisories/GHSA-2464-fhr4-w9xw , https://github.com/advisories/GHSA-673q-mjm6-r5xr , https://github.com/advisories/GHSA-p3m5-59mp-jv5r (read 2026-11-11). The npm registry's advisory answer (https://registry.npmjs.org/-/npm/v1/security/advisories/bulk) was re-read on 2026-11-13: next 16.4.0 lists all three with vulnerable_versions ">=16.0.0 <=16.4.0", next 15.5.27 lists two (">=10.0.0 <=15.5.27" and ">=13.0.0 <=15.5.27"), next 15.5.28 and 16.4.1 list none.
// [GC] no source found (uncited): the CVE numbers of these advisories. They were not read from the pages, so none is printed or stored; the advisories are named by their GHSA ids.

export const nextVersionAdvisory = defineCheck<LocalSourceInput>({
  id: "next-version-advisory",
  size: "S",
  done: "The lockfile installs Next.js 16.4.1 or later on the 16 line, or 15.5.28 or later on the 15 line.",
  estimateChanges:
    "A patch or minor bump and a lockfile update; larger on Next.js 14 or earlier, where the fix is a major upgrade.",
  area: "Security & email",
  severity: "high",
  title: "The installed Next.js version has published security advisories",
  what: "The version of Next.js that the lockfile installs is below 16.4.1 on the 16 line, or below 15.5.28 on the 15 line: the versions that fix GHSA-2464-fhr4-w9xw (remote code execution in the image optimization API with SVG files), GHSA-673q-mjm6-r5xr (remote code execution in use cache functions that return typed arrays) and GHSA-p3m5-59mp-jv5r (denial of service in the App Router with Server Actions).",
  why: "Two of the three are rated critical: a visitor with no login could run code on the server that serves the site. A pop-up bar's booking page and a clinic's enquiry form run on the same server as the rest of the site. The fix is a version bump, and nothing on the page shows that it is missing.",
  fix: "Update Next.js to 16.4.1 or later (16 line) or 15.5.28 or later (15 line), reinstall, and commit the lockfile. The floor is different on each line, so do not move a 15 project to 16 only to fix this.",
  tech: "static, reads package.json and the lockfile (pnpm-lock.yaml, package-lock.json, npm-shrinkwrap.json or yarn.lock) as text and makes no request; the installed version is the lockfile's, never the range in package.json; the advisory list is packages/core/src/data/library-advisories.json (next, verified, checked 2026-11-11), with one fixed version per line; a version in a listed range on the 15 or 16 line is a finding that names the file, the version and the advisory ids; a version below 15 is not sure, because the advisories reach it but no fixed release exists on its line; a pre-release, a version that cannot be read, a range with no lockfile or an advisory not yet compared with its page is not sure; a pass says only that the version is outside every range in the list, so an advisory published after 2026-11-11 is not in it; nothing else of a file is printed",
  run(input, ctx) {
    return runPackageAdvisory(this, "next", input, ctx);
  },
});
