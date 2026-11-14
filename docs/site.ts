/**
 * The address the docs site is published at, used for the absolute links in the changelog feed.
 * `DOCS_URL` (the same repository variable the nightly dogfood run reads) overrides it for a build;
 * an empty value means "not set". Change the default here when the site moves, then run
 * `pnpm docs:changelog` to rewrite docs/public/changelog.atom.
 */
export const DEFAULT_DOCS_SITE = "https://gaugeline.dev";

export function docsSiteUrl(env: Record<string, string | undefined>): string {
  const raw = (env.DOCS_URL ?? "").trim() || DEFAULT_DOCS_SITE;
  const url = new URL(raw); // throws on something that is not an address
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error(`DOCS_URL must be an http or https address, not ${url.protocol}`);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}
