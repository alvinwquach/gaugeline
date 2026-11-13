import { defineCheck } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import { runPackageAdvisory } from "./package-advisory.js";

// [docs] GHSA-mrhx-c7xc-m3w5, "Zod can exhaust memory while validating oversized constrained collections" - https://github.com/advisories/GHSA-mrhx-c7xc-m3w5 (read 2026-11-11 and compared with the npm registry's advisory answer, https://registry.npmjs.org/-/npm/v1/security/advisories/bulk, re-read 2026-11-13: vulnerable_versions "<4.6.6" for zod 4.0.0 and 4.6.5, none for 4.6.6). The page's description says the flaw exists "through 4.6.5".
// [GC] no source found (uncited): that zod 3.x is affected. The registry's range "<4.6.6" includes every 3.x release, but the advisory's text names 4.6.5 as the last affected version, so the check says "not sure" for 3.x and never reports it.

export const zodVersionAdvisory = defineCheck<LocalSourceInput>({
  id: "zod-version-advisory",
  size: "S",
  done: "The lockfile installs zod 4.6.6 or later.",
  estimateChanges:
    "A version bump and a lockfile update; larger if the project is on zod 3 and a major upgrade is the only way to leave the range.",
  area: "Security & email",
  severity: "high",
  title: "The installed zod version has a published security advisory",
  what: "The version of zod that the lockfile installs is below 4.6.6, the version that fixes GHSA-mrhx-c7xc-m3w5 (memory exhaustion when validating oversized constrained collections).",
  why: "A form or an API route that validates input with zod can be made to use all its memory by an oversized request body, which takes the site down for everyone. The fix is a version bump, and a bump is easy to forget because nothing in the page shows it.",
  fix: "Update zod to 4.6.6 or later (npm install zod@latest, or the same with pnpm or yarn) and commit the lockfile. A project on zod 3 has no fixed 3.x release, so it leaves the range only by moving to zod 4, which is a migration, not a bump.",
  tech: "static, reads package.json and the lockfile (pnpm-lock.yaml, package-lock.json, npm-shrinkwrap.json or yarn.lock) as text and makes no request; the installed version is the lockfile's, never the range in package.json; the advisory list is packages/core/src/data/library-advisories.json (zod, verified, checked 2026-11-11); a version from 4.0.0 up to but not including 4.6.6 is a finding that names the file, the version and the advisory id; zod 3 and earlier is not sure, because the advisory's text names 4.6.5 as the last affected version and has no fixed 3.x release; a pre-release, a version that cannot be read, or a range with no lockfile is not sure; nothing else of a file is printed",
  run(input, ctx) {
    return runPackageAdvisory(this, "zod", input, ctx);
  },
});
