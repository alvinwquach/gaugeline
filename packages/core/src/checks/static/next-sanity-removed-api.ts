import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import { installedVersions } from "./installed-version.js";
import { codePaths, lineOf, scanSource } from "./source-scan.js";

// [docs] next-sanity 13, MIGRATE-v12-to-v13.md - https://raw.githubusercontent.com/sanity-io/next-sanity/main/packages/next-sanity/MIGRATE-v12-to-v13.md (main when read, 2026-11-11; next-sanity 13.4.0 was `latest` on npm). It lists as removed: the `useDraftModePerspective`, `useIsLivePreview` and `useDraftModeEnvironment` hooks (headings "`useDraftModePerspective` hook removed" and the two after it); the `stega` and `fetchOptions` options of `defineLive`; and the `refreshOnFocus`, `refreshOnReconnect`, `refreshOnMount`, `intervalOnGoAway` and `tag` props of `<SanityLive>`.

const ID = "next-sanity-removed-api";
const HOOKS = ["useDraftModePerspective", "useIsLivePreview", "useDraftModeEnvironment"] as const;
const PROPS = [
  "refreshOnFocus",
  "refreshOnReconnect",
  "refreshOnMount",
  "intervalOnGoAway",
  "tag",
] as const;
const OPTIONS = ["stega", "fetchOptions"] as const;

/** The text of a bracketed region at its own level only: what is nested one level deeper is blanked. */
function ownLevel(bare: string, open: number): string {
  let depth = 0;
  let out = "";
  for (let i = open; i < bare.length; i++) {
    const c = bare[i] ?? "";
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") {
      depth--;
      if (depth === 0) break;
    }
    out += depth === 1 ? c : " ";
  }
  return out;
}

/** The attribute names written directly on a JSX tag that opens at `from` (`<SanityLive`), up to its closing `>` outside any braces. */
function tagAttributes(bare: string, from: number): string[] {
  let depth = 0;
  let own = "";
  for (let i = from; i < bare.length; i++) {
    const c = bare[i] ?? "";
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) break;
    else if (depth === 0) own += c;
  }
  return [...own.matchAll(/\s([A-Za-z]\w*)(?=\s*(?:=|\s|\/|$))/g)].map((m) => m[1] ?? "");
}

export const nextSanityRemovedApi = defineCheck<LocalSourceInput>({
  id: ID,
  size: "M",
  done: "The draft mode and visual editing code uses only what the installed next-sanity version provides.",
  estimateChanges:
    "A hook swap is a few lines; the removed SanityLive props can each need a small component, as the migration guide shows.",
  area: "Launch day",
  severity: "low",
  title: "Draft mode code uses an API that next-sanity 13 removed",
  what: "The code imports a draft mode hook, or sets an option or a prop, that next-sanity 12 had and next-sanity 13 removed, and the installed version is 13 or later.",
  why: "Code copied from a site built on next-sanity 12 compiles in places and fails in others, and the failure is in preview: the editors' draft mode breaks or quietly stops refreshing while the published site looks fine, so it is noticed when a client first tries to preview a change.",
  fix: "Follow next-sanity's v12 to v13 migration guide for each name listed: useDraftModePerspective becomes the resolvePerspectiveFromCookies helper in a server component, useIsLivePreview and useDraftModeEnvironment are replaced by useIsPresentationTool and useVisualEditingEnvironment, and the removed SanityLive props and defineLive options are dropped or replaced as the guide describes.",
  tech: "static, reads the code files and package.json as text and makes no request; the installed version comes from the lockfile; it applies only when it is 13 or later; a finding for each import of useDraftModePerspective, useIsLivePreview or useDraftModeEnvironment from next-sanity or next-sanity/hooks, each of refreshOnFocus, refreshOnReconnect, refreshOnMount, intervalOnGoAway or tag written directly on a <SanityLive> tag, and each of stega or fetchOptions written directly in the options of defineLive, naming the file, line and name; a version below 13 is not a finding; a version that cannot be read, or no next-sanity in any package.json, with one of these names in the code, is not sure; no such name passes; no other text of a file is printed",
  run(input, ctx) {
    const url = `source:${input.tree.label}`;
    const used: { file: string; line: number; name: string; what: string }[] = [];
    for (const path of codePaths(input)) {
      const { code, bare } = scanSource(input.tree.files.get(path) ?? "");
      for (const m of code.matchAll(
        /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']next-sanity(?:\/hooks)?["']/g,
      )) {
        for (const part of (m[1] ?? "").split(",")) {
          const name = /^\s*([A-Za-z_$][\w$]*)/.exec(part)?.[1];
          if (name !== undefined && (HOOKS as readonly string[]).includes(name))
            used.push({ file: path, line: lineOf(code, m.index), name, what: "hook" });
        }
      }
      for (const m of bare.matchAll(/<SanityLive\b/g))
        for (const name of tagAttributes(bare, m.index))
          if ((PROPS as readonly string[]).includes(name))
            used.push({ file: path, line: lineOf(bare, m.index), name, what: "SanityLive prop" });
      for (const m of bare.matchAll(/\bdefineLive\s*\(\s*(?=\{)/g)) {
        const open = m.index + m[0].length;
        const text = ownLevel(bare, open);
        for (const name of OPTIONS)
          if (new RegExp(`(?:^|[,{\\s])${name}\\s*[:,}]`).test(text))
            used.push({ file: path, line: lineOf(bare, m.index), name, what: "defineLive option" });
      }
    }
    if (used.length === 0) return [];
    const versions = installedVersions(input, "next-sanity");
    const v13 = versions.find(
      (v) => v.state === "version" && Number(v.version.split(".")[0]) >= 13,
    );
    if (v13?.state === "version") {
      return used.map((u): Finding => ({
        checkId: ID,
        severity: "low",
        title: this.title,
        evidence: `${u.file}:${u.line}: ${u.name} (a ${u.what}) was removed in next-sanity 13, and ${v13.from}:${v13.line} installs ${v13.version}.`,
        url,
        source: { file: u.file, line: u.line },
      }));
    }
    if (versions.length > 0 && versions.every((v) => v.state === "version")) return [];
    ctx.couldNotCheck?.(
      url,
      `${used[0]?.file}:${used[0]?.line} uses ${used[0]?.name}, which next-sanity 13 removed, and Gaugeline cannot read which next-sanity version is installed.`,
    );
    return [];
  },
});
