import type { PageSnapshot } from "../snapshot.js";

/**
 * A Nuxt site, from its responses: an x-powered-by: Nuxt header (the renderer and the payload
 * route send it), or, behind a proxy that strips it, its HTML: the __NUXT_DATA__ payload script, a
 * data-nuxt-data attribute, window.__NUXT__, or scripts under /_nuxt/ (the default buildAssetsDir).
 * Pure over the response; nothing is requested.
 */
export function isNuxtSite(page: PageSnapshot): boolean {
  const headers = page.hops.at(-1)?.headers ?? {};
  if (/^nuxt\b/i.test((headers["x-powered-by"] ?? "").trim())) return true;
  if (page.scripts.some((s) => /\/_nuxt\//.test(s))) return true;
  const body = page.hops.at(-1)?.body ?? "";
  return (
    body.includes("__NUXT_DATA__") ||
    body.includes("data-nuxt-data") ||
    body.includes("window.__NUXT__")
  );
}

/** Added to a rendered-versus-sent finding on a Nuxt site. */
export const NUXT_RENDERED_NOTE =
  "On this Nuxt site the content may arrive only after the page's scripts run (a route set to ssr: false, or a client-only page).";
