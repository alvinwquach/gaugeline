/**
 * The one place a link to Gaugeline's own documentation is built. Internal: it is not exported from the package
 * index, so the public surface does not change. The base is the GitHub-hosted docs of this repository, so a link
 * names no domain Gaugeline has to own; to move the docs to a site of their own, change DOCS_BASE and nothing else.
 * The pull request comment's check links are the first user; every other link to the docs is meant to come
 * through here too.
 */

/** Where the docs are, as a folder address ending in a slash. */
const DOCS_BASE = "https://github.com/alvinwquach/gaugeline/blob/main/docs/";

/** The checks reference: one page, `docs/checks.md`, which names each check by its id. */
export const CHECKS_DOCS_BASE = `${DOCS_BASE}checks.md`;

/** A check's entry in the checks reference. `id` must be a check id (a slug); the caller checks that. */
export function checkDocsUrl(id: string): string {
  return `${CHECKS_DOCS_BASE}#${id}`;
}
