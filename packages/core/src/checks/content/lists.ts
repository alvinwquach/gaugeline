/**
 * The phrase and host lists the content checks match, frozen and English. A list can be read,
 * tested and argued about in a pull request; a looser pattern would flag a real article called
 * "Testing in production". Content in other languages is missed until someone adds phrases.
 */

/** Whole titles or h1s (case and punctuation ignored) that mean the page was never named. */
export const PLACEHOLDER_TITLES: readonly string[] = Object.freeze([
  "untitled",
  "untitled page",
  "untitled document",
  "new page",
  "page title",
  "title",
  "test",
  "test page",
  "testing",
  "staging",
  "staging site",
  "my site",
  "my website",
  "site title",
  "home page title",
]);

/** Image hosts that serve placeholder pictures. A subdomain counts; a look-alike host does not. */
export const PLACEHOLDER_IMAGE_HOSTS: readonly string[] = Object.freeze([
  "placehold.co",
  "placehold.it",
  "placeholder.com",
  "via.placeholder.com",
  "dummyimage.com",
  "picsum.photos",
  "placekitten.com",
  "placebear.com",
  "loremflickr.com",
  "fakeimg.pl",
  "placeimg.com",
  "lorempixel.com",
]);

/** Phrases that mean test or sample content is on the live page (matched as whole phrases). */
export const MOCK_PHRASES: readonly string[] = Object.freeze([
  "test product",
  "sample product",
  "sample post",
  "sample page",
  "test post",
  "hello world!",
  "john doe",
  "jane doe",
  "john smith example",
  "your name here",
  "product name here",
]);

/** Link text that says nothing about the destination (after trimming arrows and ellipses). */
export const VAGUE_LINK_TEXT: readonly string[] = Object.freeze([
  "read more",
  "click here",
  "learn more",
  "here",
]);

/** Link shorteners and redirectors an outbound link can leave through. */
export const REDIRECTOR_HOSTS: readonly string[] = Object.freeze([
  "bit.ly",
  "t.co",
  "lnkd.in",
  "buff.ly",
  "ow.ly",
  "tinyurl.com",
  "goo.gl",
  "rebrand.ly",
  "is.gd",
  "cutt.ly",
  "shorturl.at",
  "tiny.cc",
]);

/** Paths that bounce to another address in a query parameter: /redirect?url=..., /out?to=... */
export const REDIRECT_PATH = /^\/(?:redirect|redir|out|go|outbound|link|r)\/?$/i;
export const REDIRECT_PARAMS: readonly string[] = Object.freeze([
  "url",
  "u",
  "to",
  "target",
  "dest",
  "destination",
  "redirect",
  "q",
]);

/** True when a host is one of the list or a subdomain of one: "www.bit.ly" yes, "notbit.ly" no. */
export function hostIn(host: string, list: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return list.some((d) => h === d || h.endsWith(`.${d}`));
}
