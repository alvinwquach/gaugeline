import data from "../data/hosted-builders.json";
import type { PageSnapshot } from "../snapshot.js";

export interface HostedBuilder {
  id: "wix" | "squarespace" | "webflow" | "framer";
  name: string;
}

interface Spec extends HostedBuilder {
  hosts: readonly string[];
  generator: readonly string[];
  headers?: readonly string[];
  serverHeader?: readonly string[];
  htmlAttributes?: readonly string[];
}

/** The builders whose plan is a fixed price, so account-level usage does not apply to them. */
export const HOSTED_BUILDERS: readonly HostedBuilder[] = Object.freeze(
  (data.builders as Spec[]).map((b) => Object.freeze({ id: b.id, name: b.name })),
);

const SPECS: readonly Spec[] = data.builders as Spec[];

const GENERATOR = /<meta\b[^>]*>/gi;

/** The generator meta tag's content, lower case, whichever order its attributes are in. */
function generatorOf(html: string): string {
  for (const tag of html.match(GENERATOR) ?? []) {
    if (!/\bname\s*=\s*["']generator["']/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    return (content?.[1] ?? content?.[2] ?? "").toLowerCase();
  }
  return "";
}

const hostIn = (host: string, wanted: readonly string[]): boolean =>
  wanted.some((w) => host === w || host.endsWith(`.${w}`));

/**
 * The hosted builder a page is served by, from what the page itself shows: the host names of its
 * scripts and images, the generator tag, a response header, an attribute on the html element.
 * A word in the page's text is never a sign. Undefined for anything else, which includes every
 * self-hosted site. Pure.
 */
export function detectBuilder(page: PageSnapshot): HostedBuilder | undefined {
  const last = page.hops.at(-1);
  const headers = last?.headers ?? {};
  const body = last?.body ?? "";
  const generator = generatorOf(body);
  const hosts = new Set<string>();
  // Assets only: a link to a builder's own site is a footer credit, not a sign the page is served by it.
  for (const url of [...page.scripts, ...page.images.map((i) => i.src)]) {
    try {
      hosts.add(new URL(url, page.finalUrl).hostname.toLowerCase());
    } catch {
      // not an address
    }
  }
  const server = (headers.server ?? "").toLowerCase();
  const hit = SPECS.find(
    (b) =>
      b.generator.some((g) => generator.startsWith(g)) ||
      [...hosts].some((h) => hostIn(h, b.hosts)) ||
      (b.headers ?? []).some((h) => headers[h] !== undefined) ||
      (b.serverHeader ?? []).some((s) => server.startsWith(s)) ||
      (b.htmlAttributes ?? []).some((a) => new RegExp(`<html\\b[^>]*\\s${a}\\b`, "i").test(body)),
  );
  return hit ? { id: hit.id, name: hit.name } : undefined;
}
