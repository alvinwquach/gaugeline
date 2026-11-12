/**
 * Addresses a Nuxt site serves for itself, not as pages: build output under /_nuxt/ (the default
 * buildAssetsDir), page payloads (_payload.json, or _payload.js without JSON payloads), island
 * components (/__nuxt_island/) and the dev tools (/__nuxt_devtools__). Discovery ignores them.
 * A base URL is not handled: a site served under a prefix has its own prefix before these.
 */
const NUXT_PATH = /^\/(?:_nuxt\/|__nuxt_island\/|__nuxt_devtools__(?:\/|$))|\/_payload\.js(?:on)?$/;

export function isNuxtFrameworkUrl(url: string): boolean {
  try {
    return NUXT_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}
