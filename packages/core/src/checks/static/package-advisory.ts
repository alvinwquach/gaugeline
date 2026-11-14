import type { CheckContext, Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import {
  inRange,
  PACKAGE_ADVISORIES,
  PACKAGE_INFO,
  type Advisory,
  type PackageId,
} from "../../libraries/advisories.js";
import { compareVersions, parseVersion } from "../../libraries/version.js";
import { installedVersions } from "./installed-version.js";

/**
 * What the version checks share (batch FF): the installed version of one npm package, read from the
 * lockfile (installed-version.ts), compared with the package's advisories in data/library-advisories.json
 * (the same list shape and the same `verified` flag as the served-library check). A check makes no request
 * and runs no code. It says one of three things for each package.json that declares the package:
 *
 * - a finding: the installed version is in the published affected range of an advisory that has been
 *   compared with its page (`verified`), with the advisory ids and the version that fixes it on that line;
 * - not sure (could-not-check): the version cannot be read, is a pre-release, is in a range Gaugeline has not
 *   confirmed (`unconfirmed`), or is in the range of an advisory not yet compared with its page. A
 *   threshold that is not verified is never enforced;
 * - nothing (a pass): the version is outside every range in the list. That says only what the list says; an
 *   advisory published after `lastChecked` is not in it, and the docs say so.
 */

interface Self {
  id: string;
  title: string;
  severity: "high" | "medium" | "low";
}

export function runPackageAdvisory(
  self: Self,
  pkg: PackageId,
  input: LocalSourceInput,
  ctx: CheckContext,
  advisories: readonly Advisory[] = PACKAGE_ADVISORIES[pkg],
): Finding[] {
  const url = `source:${input.tree.label}`;
  const name = PACKAGE_INFO[pkg].name;
  const out: Finding[] = [];
  const unsure = (reason: string): void => ctx.couldNotCheck?.(url, reason);
  for (const found of installedVersions(input, pkg)) {
    if (found.state === "unsure") {
      unsure(found.reason);
      continue;
    }
    const { version, from, line, declaredIn } = found;
    const where = `${from}:${line}`;
    if (parseVersion(version) === undefined) {
      unsure(`${where} gives ${pkg} as ${version}, which Gaugeline cannot read as a version.`);
      continue;
    }
    if (parseVersion(version)?.pre !== undefined) {
      unsure(
        `${where} installs ${name} ${version}, a pre-release. The advisory ranges are for releases, so Gaugeline does not judge a pre-release.`,
      );
      continue;
    }
    const hit: { id: string; fixedIn: string }[] = [];
    const notCompared: string[] = [];
    const notConfirmed: { id: string; why: string }[] = [];
    for (const a of advisories) {
      const range = a.affects.find((r) => inRange(version, r));
      if (range !== undefined) {
        if (a.verified && range.fixed !== null) hit.push({ id: a.id, fixedIn: range.fixed });
        else notCompared.push(a.id);
      } else if (a.unconfirmed?.some((r) => inRange(version, r)) === true) {
        notConfirmed.push({ id: a.id, why: a.unconfirmedWhy ?? "the range is not confirmed" });
      }
    }
    if (hit.length > 0) {
      // The version that clears every listed advisory on this line.
      const fixed = hit.reduce(
        (best, h) => ((compareVersions(h.fixedIn, best) ?? 0) > 0 ? h.fixedIn : best),
        hit[0]?.fixedIn ?? "",
      );
      out.push({
        checkId: self.id,
        severity: self.severity,
        title: self.title,
        evidence: `${where}: ${name} ${version} is installed (${declaredIn} asks for ${found.declared}). That version is in the published affected range of ${hit.map((h) => h.id).join(", ")}. Fixed in ${fixed} on this line.`,
        url,
        source: { file: from, line },
      });
    } else if (notCompared.length > 0) {
      unsure(
        `${where} installs ${name} ${version}, which is in the range of ${notCompared.join(", ")}. Gaugeline's list has not compared that advisory with its page, so the floor is unverified and it is not reported as a finding.`,
      );
    } else if (notConfirmed.length > 0) {
      unsure(
        `${where} installs ${name} ${version}. ${notConfirmed[0]?.id} reaches that version, but ${notConfirmed[0]?.why}.`,
      );
    }
  }
  return out;
}
