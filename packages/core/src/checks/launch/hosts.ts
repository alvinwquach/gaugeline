/**
 * Hosting providers' temporary addresses: every preview and every project gets one under these
 * suffixes. A frozen list, extended one line at a time; a suffix match can't catch vercel.com.
 */
export const TEMP_HOST_SUFFIXES: readonly string[] = Object.freeze([
  "vercel.app",
  "netlify.app",
  "pages.dev",
]);

/** project.vercel.app, site.netlify.app, x.pages.dev: a name under a temporary suffix (not the suffix itself). */
export function isTemporaryHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return TEMP_HOST_SUFFIXES.some((s) => h.endsWith(`.${s}`));
}
