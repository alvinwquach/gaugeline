import { compare, parseVersion } from "../advisory/range.js";
import { wordpressOf, type WordPressAsset, type WordPressRead } from "../advisory/signals.js";
import type { CheckContext, Finding } from "../model.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import type { Latest, WordPress } from "../wordpress/reader.js";
import { escapeInvisible } from "./hidden-text/escape.js";

const clip = (text: string): string => escapeInvisible(text, 120);

/** The most plugins, and the most themes, one run compares with wordpress.org: one request each. */
export const WORDPRESS_ASSET_CAP = 15;

/** The WordPress a page shows, from its own HTML and headers: undefined when the page shows none. */
function wordpressOfPage(page: PageSnapshot): { read: WordPressRead; html: string } | undefined {
  const last = page.hops.at(-1);
  const html = last?.body ?? "";
  const read = wordpressOf(html, last?.headers ?? {});
  return read ? { read, html } : undefined;
}

/**
 * The REST root a page names with `<link rel="https://api.w.org/" href="...">`, when it is on the page's own
 * site; otherwise /wp-json/ on the page's own origin. Never an address on another host.
 */
export function restRootOf(html: string, pageUrl: string): string {
  const origin = new URL(pageUrl).origin;
  const tag = /<link\b[^>]*>/gi;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    if (!/\brel\s*=\s*["']https:\/\/api\.w\.org\/?["']/i.test(m[0])) continue;
    const href = /\bhref\s*=\s*["']([^"']{1,300})["']/i.exec(m[0])?.[1];
    if (!href) continue;
    try {
      const root = new URL(href, pageUrl);
      if (root.origin === origin && !root.search) return root.href;
    } catch {
      // not an address
    }
  }
  return `${origin}/wp-json/`;
}

const OUTDATED_TITLE = "WordPress, a plugin or a theme is older than its current release";

interface Component {
  kind: "core" | "plugin" | "theme";
  slug: string;
  /** What the page shows: the version, and how it was read. */
  version: string;
  how: string;
}

const labelOf = (c: Pick<Component, "kind" | "slug">): string =>
  c.kind === "core" ? "WordPress" : `The ${c.kind} ${clip(c.slug)}`;

/** The finding for one component whose version is older than wordpress.org's current one, or undefined. */
function compared(c: Component, latest: string): "older" | "current" | "unreadable" {
  const a = parseVersion("wordpress", c.version);
  const b = parseVersion("wordpress", latest);
  if (!a || !b) return "unreadable";
  return compare("wordpress", a, b) < 0 ? "older" : "current";
}

function assetVersion(asset: WordPressAsset): { version?: string; several?: string[] } {
  const versions = [...new Set(asset.versions)];
  if (versions.length === 1) return { version: versions[0] ?? "" };
  return versions.length > 1 ? { several: versions } : {};
}

const list = (names: string[]): string => {
  const shown = names.slice(0, 5).map(clip).join(", ");
  return names.length > 5 ? `${shown} and ${names.length - 5} more` : shown;
};

export const wpOutdated = defineCheck<PageSnapshot>({
  id: "wp-outdated",
  size: "M",
  done: "WordPress, the plugins and the theme the finding names are on their current release (or the client has decided with the developer why one stays), and running Gaugeline again shows the new version numbers.",
  estimateChanges:
    "An hour when the site has a staging copy and the updates are clean. A day or more when a plugin is years behind, the theme is customised, or nobody has tested updates on this site before.",
  area: "Security & email",
  severity: "medium",
  title: OUTDATED_TITLE,
  what: "Gaugeline reads the WordPress version a page shows (the generator tag, or the version on the files WordPress loads from wp-includes) and the version of each plugin and theme in the addresses of the files the page loads, and compares them with the current releases the public wordpress.org API lists.",
  why: "Most WordPress updates fix something, and a site that falls behind keeps the problems the updates fixed. This states which versions are shown and which are current; it does not say a site can be attacked. A site that hides its versions is not reported as up to date: Gaugeline says it could not check.",
  fix: "Take a backup, update on a staging copy if there is one, then update WordPress, the plugins and the theme the finding names, and look at the pages that use them. A premium plugin that is not in the wordpress.org directory is updated from its own vendor and is listed as could-not-check here.",
  tech: "Only with --wordpress. The version of WordPress is the generator meta tag (WordPress 6.4.2), else the ?ver= on the core files under /wp-includes/ (the emoji and block-library files); a plugin's or theme's version is the ?ver= on its files under /wp-content/plugins/<slug>/ or /wp-content/themes/<slug>/, read as a release number written with dots (2.1.3, 5.8, 1.0.0-beta2) and never a date, a hash or a timestamp, which are cache-busters; a number that is WordPress's own (what WordPress writes when a plugin gives none) is not the plugin's. A plugin whose files carry more than one number, or none, is could-not-check. The current releases are one GET each to https://api.wordpress.org/core/version-check/1.7/ and https://api.wordpress.org/plugins/info/1.2/ (themes/info/1.2/ for a theme) with the slug the page shows, no key and nothing sent, at most 15 plugins and 15 themes for a run. A plugin or theme not in the directory (a premium or custom one) is could-not-check. A page the run reaches on a site that is not WordPress is skipped. Versions are compared as whole numbers in four parts (5.10 is after 5.8), and each component is reported once per run, on the first page that shows it.",
  async run(page, ctx: CheckContext) {
    const wp: WordPress | undefined = ctx.wordpress;
    if (!wp) return [];
    const shown = wordpressOfPage(page);
    if (!shown) return [];
    const { read } = shown;
    const url = page.finalUrl;
    const out: Finding[] = [];
    const components: Component[] = [];

    if (wp.claim("core")) {
      if (read.version)
        components.push({
          kind: "core",
          slug: "wordpress",
          version: read.version.value,
          how: read.version.how,
        });
      else
        ctx.couldNotCheck?.(
          url,
          "This site runs WordPress, but the page shows no version (no generator tag and no versioned file under /wp-includes/), so it was not compared with the current release. That is not the same as up to date.",
        );
    }

    const hidden: string[] = [];
    const several: string[] = [];
    for (const [kind, assets] of [
      ["plugin", read.plugins],
      ["theme", read.themes],
    ] as const) {
      if (assets.length > WORDPRESS_ASSET_CAP && wp.claim(`${kind}-cap`))
        ctx.couldNotCheck?.(
          url,
          `${assets.length - WORDPRESS_ASSET_CAP} ${kind}s were not compared: at most ${WORDPRESS_ASSET_CAP} are looked up for one run.`,
        );
      for (const asset of assets.slice(0, WORDPRESS_ASSET_CAP)) {
        if (!wp.claim(`${kind}:${asset.slug}`)) continue;
        const v = assetVersion(asset);
        if (v.version)
          components.push({
            kind,
            slug: asset.slug,
            version: v.version,
            how: `the ?ver= on its files on this page`,
          });
        else if (v.several) several.push(`${kind} ${asset.slug} (${v.several.join(", ")})`);
        else hidden.push(`${kind} ${asset.slug}`);
      }
    }

    const unlisted: string[] = [];
    for (const c of components) {
      const latest: Latest = await wp.latest(c.kind, c.slug);
      if (!latest.ok) {
        if (latest.unlisted) unlisted.push(`${c.kind} ${c.slug}`);
        else
          ctx.couldNotCheck?.(
            url,
            `${labelOf(c)} ${clip(c.version)} was not compared: ${clip(latest.reason)}`,
          );
        continue;
      }
      const result = compared(c, latest.version);
      if (result === "unreadable") {
        ctx.couldNotCheck?.(
          url,
          `${labelOf(c)} shows the version ${clip(c.version)} and the current release is ${clip(latest.version)}, and Gaugeline could not compare them.`,
        );
        continue;
      }
      if (result === "older")
        out.push({
          checkId: "wp-outdated",
          severity: "medium",
          title: this.title,
          evidence: `${labelOf(c)} ${clip(c.version)} is shown (read from ${c.how}); the current release in the wordpress.org ${c.kind === "core" ? "API" : "directory"} is ${clip(latest.version)}.`,
          url: clip(url),
        });
    }

    if (unlisted.length > 0)
      ctx.couldNotCheck?.(
        url,
        `${unlisted.length} ${unlisted.length === 1 ? "component is" : "components are"} not in the wordpress.org directory (${list(unlisted)}), so there is no public current version to compare with: a premium or custom plugin or theme is updated from its vendor.`,
      );
    if (hidden.length > 0)
      ctx.couldNotCheck?.(
        url,
        `${hidden.length} ${hidden.length === 1 ? "file set shows" : "file sets show"} no version Gaugeline can read (${list(hidden)}): the files carry no ?ver=, or a date, a hash or a build number, which is a cache-buster and not a version. They were not compared with their current releases.`,
      );
    if (several.length > 0)
      ctx.couldNotCheck?.(
        url,
        `${several.length === 1 ? "A plugin or theme shows" : "Plugins or themes show"} more than one version number on its files (${list(several)}), so the plugin's own number is not known and it was not compared.`,
      );
    return out;
  },
});

export const wpUsersExposed = defineCheck<PageSnapshot>({
  id: "wp-users-exposed",
  size: "S",
  done: "The REST API's list of users answers a visitor with no login with an error or an empty list, and running Gaugeline again finds no users listed.",
  estimateChanges:
    "Minutes with a hardening plugin or a small snippet in the theme. A site whose app or booking plugin needs the list public takes longer, because it has to be given another way first.",
  area: "Security & email",
  severity: "medium",
  title: "The site's REST API lists its users to anyone",
  what: "Gaugeline asks the site's REST API for its list of users the way a visitor's browser can, with no login, and reports when it answers with users.",
  why: "The list gives each author's display name and the slug that is often also the login name, so anyone can learn who the accounts are before guessing passwords. It is on by default in WordPress, which is why it is common, and closing it costs a site very little. This is a fact about what is listed, not a sign of a break-in.",
  fix: "Restrict the users route to logged-in users: most security plugins have the setting, or a short snippet in the theme's functions.php removes it for visitors. Check the author archive pages the theme shows, and that no plugin or app on the site needs the list public.",
  tech: "Only with --wordpress. One GET of the REST root the page names in its api.w.org link (the same site only), /wp-json/wp/v2/users?per_page=100&_fields=id, with no key; if /wp-json/ answers 404, one GET of /?rest_route=/wp/v2/users (a site with plain permalinks). Only the id is asked for, so no name or slug is sent back, and only how many users were listed is kept and shown. A 401, 403 or 404 from both routes, or an empty list, is not exposed. Any other answer, an answer that is not a list, or a request that fails is could-not-check. The route is a documented, public REST route, so it is not a probing check under rule 14; it is still off unless --wordpress is given. Pages of a site that is not WordPress are skipped, and the site is asked once per run.",
  async run(page, ctx: CheckContext) {
    const wp: WordPress | undefined = ctx.wordpress;
    if (!wp) return [];
    const shown = wordpressOfPage(page);
    if (!shown) return [];
    const root = restRootOf(shown.html, page.finalUrl);
    if (!wp.claim(`users:${root}`)) return [];
    const got = await wp.users(root);
    if (!got.ok) {
      ctx.couldNotCheck?.(
        page.finalUrl,
        `${clip(got.reason)} Whether the site lists its users was not checked.`,
      );
      return [];
    }
    if (!got.exposed) return [];
    return [
      {
        checkId: "wp-users-exposed",
        severity: "medium",
        title: this.title,
        evidence: `GET ${clip(got.route)} with no login listed ${got.listed} ${got.listed === 1 ? "user" : "users"}. Only the count was read; no name or slug was asked for or kept.`,
        url: clip(page.finalUrl),
      },
    ];
  },
});

export const WORDPRESS_CHECKS = [wpOutdated, wpUsersExposed] as const;
