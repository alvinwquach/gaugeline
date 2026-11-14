import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import {
  importsOf,
  inFunctionBody,
  lineOf,
  notReadReason,
  resolveImport,
  scrub,
  sortFindings,
  sourcePathsOf,
} from "./scan.js";

/**
 * FF-16 (advice): a content-system client created when a framework's config file loads. The config is
 * read by every build, test run and tool that imports it, so each of them then needs the project's
 * settings (often a fake value in an environment variable), and the client's setup runs at build time.
 * Looked at: `next`, `nuxt`, `astro`, `svelte`, `remix`, `vite`, `react-router` and `gatsby-config`
 * files; a client made in a function (a `redirects()` method, an arrow) is left alone, and a config that
 * imports a local module which makes its client at the top level is a finding too. Static: it reads the
 * code and runs none of it.
 *
 * // [GC] no source found (uncited): that this forces fake environment variables into tests and runs the client's setup at build time. It is the owner's reason for the check; the text says what the code does (it creates a client when the file loads) and not more.
 */
const ID = "cms-client-in-framework-config";

const CONFIG_FILE =
  /(?:^|\/)(?:(?:next|nuxt|astro|svelte|remix|vite|react-router)\.config|gatsby-config)\.[cm]?[jt]s$/;
/** Packages that make a client for a content system. */
const CMS_PACKAGES = [
  "@sanity/client",
  "next-sanity",
  "contentful",
  "@prismicio/client",
  "@directus/sdk",
  "@datocms/cda-client",
  "datocms-client",
  "storyblok-js-client",
  "@storyblok/js",
  "@contentstack/delivery-sdk",
  "contentstack",
  "@kontent-ai/delivery-sdk",
  "@tryghost/content-api",
  "@strapi/client",
];
const CREATES =
  /\b(?:createClient|createDirectus|createDeliveryClient|createManagementClient|createPrismicClient)\s*\(|\bnew\s+(?:StoryblokClient|GhostContentAPI|\w+Client)\s*\(/g;

const isCmsPackage = (spec: string): boolean =>
  CMS_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`));

/** Where the file makes a content client when it loads: the index of each call outside a function. */
function loadTimeClients(text: string): number[] {
  const code = scrub(text, false);
  if (!importsOf(code).some((i) => isCmsPackage(i.spec))) return [];
  const bare = scrub(text, true);
  const at: number[] = [];
  for (const m of bare.matchAll(CREATES)) if (!inFunctionBody(bare, m.index)) at.push(m.index);
  return at;
}

export const cmsClientInFrameworkConfig = defineCheck<LocalSourceInput>({
  id: ID,
  size: "S",
  done: "The framework's config file makes no content client: it is made in a function, in a module the config does not import.",
  estimateChanges:
    "Minutes if the client is only used for one list: move it into the function that needs it. More if the config's values come from the content system and need a build step.",
  area: "Launch day",
  severity: "low",
  title: "A content client is created when the framework's config file loads",
  what: "A framework's config file (next.config, nuxt.config, astro.config and similar) makes a client for a content system such as Sanity or Contentful at the top level, or imports a module that does.",
  why: "Every build, every test run and every tool that reads the config now runs the client's setup and needs its settings, so a fake project id ends up in each of them, and the setup runs at build time whether or not a page needs it.",
  fix: "Keep the config file free of clients. Make the client in the function that reads content, and keep the few values the config needs (a redirect list, an image host) as plain data, or generate them in a script that runs before the build.",
  tech: "reads the code files of the folder named, never runs them; looks at next.config, nuxt.config, astro.config, svelte.config, remix.config, vite.config, react-router.config and gatsby-config files (.js, .mjs, .cjs, .ts); a file that imports a content-system package (@sanity/client, next-sanity, contentful, @prismicio/client, @directus/sdk, DatoCMS, Storyblok, Contentstack, Kontent, Ghost, Strapi) and calls createClient, createDirectus, createDeliveryClient, createManagementClient, createPrismicClient or new <Name>Client outside a function is a finding at that line; so is a config that imports a local module that does; a call inside a function or a dynamic import is not; no source file read, or some left out, is could-not-check; the finding names the file and the line, never a setting",
  run(input, ctx) {
    const { tree } = input;
    const url = `source:${tree.label}`;
    const findings: Finding[] = [];
    for (const file of sourcePathsOf(tree).filter((p) => CONFIG_FILE.test(p))) {
      const text = tree.files.get(file) ?? "";
      const own = loadTimeClients(text)[0];
      if (own !== undefined) {
        const line = lineOf(scrub(text, true), own);
        findings.push({
          checkId: ID,
          severity: "low",
          title: this.title,
          evidence: `${file}:${line}: a content client is created when this config file loads.`,
          url,
          source: { file, line },
        });
        continue;
      }
      for (const imp of importsOf(scrub(text, false))) {
        const target = resolveImport(tree.files, file, imp.spec);
        if (target === undefined || loadTimeClients(tree.files.get(target) ?? "").length === 0)
          continue;
        const line = lineOf(scrub(text, false), imp.index);
        findings.push({
          checkId: ID,
          severity: "low",
          title: this.title,
          evidence: `${file}:${line}: this config file imports ${target}, which creates a content client when it loads.`,
          url,
          source: { file, line },
        });
        break;
      }
    }
    sortFindings(findings);
    if (findings.length === 0) {
      const why = notReadReason(tree);
      if (why !== undefined) ctx.couldNotCheck?.(url, why);
    }
    return findings;
  },
});
