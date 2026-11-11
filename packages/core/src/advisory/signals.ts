/**
 * The signs a response and a page give of what they are built on, as pure functions of text that was already
 * fetched. Nothing here requests anything. The patterns were written from what these tools are known to leave
 * in a page and have not been compared with real builds: they find a version only from a whole shape, and when
 * none matches the version is not guessed.
 */

type Headers = Record<string, string>;

interface Named {
  name: string;
  is: (h: Headers) => boolean;
}

const has = (h: Headers, name: string): boolean => h[name] !== undefined;
const server = (h: Headers, re: RegExp): boolean => re.test(h.server ?? "");

/** Hosts that run the site (a platform): what they send is the host's own, not an origin's. */
const PLATFORMS: readonly Named[] = [
  { name: "Vercel", is: (h) => has(h, "x-vercel-id") || server(h, /^vercel$/i) },
  { name: "Netlify", is: (h) => has(h, "x-nf-request-id") || server(h, /^netlify$/i) },
  { name: "GitHub Pages", is: (h) => has(h, "x-github-request-id") || server(h, /^github\.com$/i) },
  {
    name: "WP Engine",
    is: (h) => /wp ?engine/i.test(h["x-powered-by"] ?? "") || has(h, "x-wpe-request-id"),
  },
  { name: "Kinsta", is: (h) => has(h, "x-kinsta-cache") },
  { name: "Pantheon", is: (h) => has(h, "x-pantheon-styx-hostname") || has(h, "x-styx-req-id") },
  { name: "Shopify", is: (h) => has(h, "x-shopid") || has(h, "x-shopify-stage") },
  { name: "Squarespace", is: (h) => server(h, /^squarespace/i) },
  { name: "Wix", is: (h) => has(h, "x-wix-request-id") },
  { name: "Render", is: (h) => has(h, "x-render-origin-server") },
  { name: "Fly.io", is: (h) => has(h, "fly-request-id") },
];

/** A CDN in front of an origin: it can add, replace or remove what the origin sent. */
const CDNS: readonly Named[] = [
  { name: "Cloudflare", is: (h) => has(h, "cf-ray") || server(h, /^cloudflare/i) },
  {
    name: "CloudFront",
    is: (h) =>
      has(h, "x-amz-cf-id") || /cloudfront/i.test(h.via ?? "") || server(h, /^cloudfront$/i),
  },
  { name: "Fastly", is: (h) => has(h, "x-fastly-request-id") },
  { name: "Akamai", is: (h) => has(h, "x-akamai-transformed") || server(h, /^akamaighost/i) },
  { name: "Bunny", is: (h) => server(h, /^bunnycdn/i) },
  { name: "Sucuri", is: (h) => has(h, "x-sucuri-id") },
];

/** The platform and the CDN a response's headers name, if any. */
export function hostingOf(h: Headers): { hosting?: string; cdn?: string } {
  const hosting = PLATFORMS.find((p) => p.is(h))?.name;
  const cdn = CDNS.find((p) => p.is(h))?.name;
  return { ...(hosting ? { hosting } : {}), ...(cdn ? { cdn } : {}) };
}

/** PHP's version from X-Powered-By or Server ("PHP/8.1.27", "PHP/8.1.2-1ubuntu2" is 8.1.2). */
export function phpFromHeaders(h: Headers): { version?: string; how: string } | undefined {
  const power = /\bPHP\/(\d+(?:\.\d+){1,3})/i.exec(h["x-powered-by"] ?? "");
  if (power) return { version: power[1] ?? "", how: "the X-Powered-By header" };
  const srv = /\bPHP\/(\d+(?:\.\d+){1,3})/i.exec(h.server ?? "");
  if (srv) return { version: srv[1] ?? "", how: "the Server header" };
  if (/^PHP\b/i.test(h["x-powered-by"] ?? "")) return { how: "the X-Powered-By header" };
  if (/(?:^|[,;\s])PHPSESSID=/.test(h["set-cookie"] ?? "")) return { how: "a PHPSESSID cookie" };
  return undefined;
}

/** The generator meta tag's content, as written, cut to 100 characters. */
export function generatorOf(html: string): string | undefined {
  const tag = /<meta\b[^>]*>/gi;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    if (!/\bname\s*=\s*["']generator["']/i.test(m[0])) continue;
    const content = /\bcontent\s*=\s*["']([^"']{1,100})["']/i.exec(m[0])?.[1];
    if (content) return content.trim();
  }
  return undefined;
}

/**
 * The version in a Next.js build's client code: the object a build assigns to window.next, with the version
 * first. Undefined when that shape is not there.
 */
export function nextVersionOf(script: string): string | undefined {
  return /window\.next\s*=\s*\{\s*version\s*:\s*"(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]{1,30})?)"/.exec(
    script,
  )?.[1];
}

export interface WordPressAsset {
  slug: string;
  /** The distinct versions the page's files for it carry. Empty when none does. */
  versions: string[];
}

export interface WordPressRead {
  /** What on the page or in the headers says this is WordPress. */
  signs: string[];
  version?: { value: string; how: string };
  plugins: WordPressAsset[];
  themes: WordPressAsset[];
}

const VER = /[?&](?:#038;|amp;)*ver=(\d[0-9A-Za-z._-]{0,20})/;

/** The core files whose ?ver= is WordPress's own number (the bundled libraries, jQuery among them, carry theirs). */
const CORE_FILE =
  /\/wp-includes\/(?:js\/wp-emoji-release\.min\.js|js\/wp-embed\.min\.js|css\/classic-themes(?:\.min)?\.css|css\/dist\/block-library\/[^"'\s>?]*|blocks\/[^"'\s>?]*)(\?[^"'\s>]*)/;

const MAX_ASSETS = 40;

/**
 * Whether a page is WordPress, which version, and which plugins and themes it serves files from, from the
 * page's own HTML and headers. A plugin's version is the ?ver= on its files, which most plugins set to their
 * own version; when it is WordPress's own number (what WordPress writes when a plugin gives none) it is not
 * the plugin's version and is left out.
 */
export function wordpressOf(html: string, h: Headers): WordPressRead | undefined {
  const signs: string[] = [];
  if (/\/wp-content\//i.test(html)) signs.push("files under /wp-content/");
  if (/\/wp-includes\//i.test(html)) signs.push("files under /wp-includes/");
  if (/rel=["']https:\/\/api\.w\.org\/?["']/i.test(html) || /api\.w\.org/i.test(h.link ?? ""))
    signs.push("the WordPress REST API link");
  if (/xmlrpc\.php/i.test(h["x-pingback"] ?? "")) signs.push("the X-Pingback header");
  const generator = generatorOf(html);
  const gen = /^WordPress\s+(\d+(?:\.\d+){1,3})\b/i.exec(generator ?? "");
  if (gen) signs.push("the generator tag");
  if (signs.length === 0) return undefined;
  let version = gen ? { value: gen[1] ?? "", how: "the generator tag" } : undefined;
  if (!version) {
    const core = CORE_FILE.exec(html);
    const v = VER.exec(core?.[1] ?? "")?.[1];
    if (v) version = { value: v, how: "the version on the site's wp-includes files" };
  }
  const plugins = new Map<string, Set<string>>();
  const themes = new Map<string, Set<string>>();
  const asset = /\/wp-content\/(plugins|themes)\/([a-z0-9][a-z0-9._-]{0,79})\/[^"'\s>]*/gi;
  for (let m = asset.exec(html); m; m = asset.exec(html)) {
    const into = m[1]?.toLowerCase() === "plugins" ? plugins : themes;
    const slug = (m[2] ?? "").toLowerCase();
    if (!into.has(slug) && into.size >= MAX_ASSETS) continue;
    const versions = into.get(slug) ?? new Set<string>();
    into.set(slug, versions);
    const v = VER.exec(m[0])?.[1];
    if (v && v !== version?.value) versions.add(v);
  }
  const rows = (m: Map<string, Set<string>>): WordPressAsset[] =>
    [...m].map(([slug, v]) => ({ slug, versions: [...v] }));
  return { signs, ...(version ? { version } : {}), plugins: rows(plugins), themes: rows(themes) };
}
