import { isNuxtFrameworkUrl } from "../nuxt/framework-urls.js";

/**
 * Addresses a Next.js (or, via nuxt/framework-urls, Nuxt) site serves for itself, not as pages: build output, data and image
 * endpoints, React Server Component payloads (?_rsc=) and dev overlays. Discovery ignores them.
 */
const FRAMEWORK_PATH = /^\/(?:_next\/|__nextjs)/;

export function isFrameworkUrl(url: string): boolean {
  if (isNuxtFrameworkUrl(url)) return true;
  try {
    const u = new URL(url);
    return FRAMEWORK_PATH.test(u.pathname) || u.searchParams.has("_rsc");
  } catch {
    return false;
  }
}
