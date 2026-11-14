/**
 * The one place a link to Gaugeline's own documentation is built. Internal: it is not exported from the package
 * index, so the public surface does not change. The base is the GitHub-hosted docs of this repository, so a link
 * names no domain Gaugeline has to own; to move the docs to a site of their own, change DOCS_BASE and nothing else.
 * The pull request comment's check links are the first user; every other link to the docs is meant to come
 * through here too.
 *
 * A check has a page GitHub can render only where a page under docs/checks names it in a table row. The checks
 * reference (docs/checks.md) is a site component with no headings, so it is not linked. A check with no page gets
 * no link at all, never a dead one: `checkDocsUrl` answers undefined. A test reads the repository and fails if an
 * entry below names a file or a row that is not there, or if a page under docs/checks is not used.
 */

/** Where the docs are, as a folder address ending in a slash. */
const DOCS_BASE = "https://github.com/alvinwquach/gaugeline/blob/main/docs/";

/** The folder of check pages, as an address ending in a slash. */
export const CHECKS_DOCS_BASE = `${DOCS_BASE}checks/`;

/** Check id to the page under docs/checks (without `.md`) whose table has a row for it. */
export const CHECK_PAGES: Readonly<Record<string, string>> = Object.freeze({
  "cms-token-in-client-code": "tokens-in-source",
  "document-hours-mismatch": "documents-agree",
  "document-item-missing": "documents-agree",
  "document-price-mismatch": "documents-agree",
  "document-unreadable": "documents-agree",
  "form-failure-shows-success": "form-handlers-in-source",
  "form-post-unguarded": "form-handlers-in-source",
  "form-values-in-logs": "personal-data-in-source",
  "groq-reference-not-expanded": "sanity-schema-in-source",
  "image-alt-not-validated": "sanity-schema-in-source",
  "personal-data-in-analytics": "personal-data-in-source",
  "section-type-component-mismatch": "sections-and-stega-in-source",
  "stega-not-cleaned": "sections-and-stega-in-source",
  "token-required-at-import": "token-and-server-code",
  "use-server-exports-not-async": "token-and-server-code",
  "webhook-url-hardcoded": "tokens-in-source",
});

/** The page that names a check, or undefined when the check has no page GitHub can show. */
export function checkDocsUrl(id: string): string | undefined {
  return Object.hasOwn(CHECK_PAGES, id) ? `${CHECKS_DOCS_BASE}${CHECK_PAGES[id]}.md` : undefined;
}
