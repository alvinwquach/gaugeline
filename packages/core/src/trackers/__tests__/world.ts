import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";

/**
 * The invented Tag Manager container the tracker tests and docs read, as GTM serves it: a custom HTML tag is a
 * string with its quotes and angle brackets written as \x27 and \x3c. One tag carries a Meta pixel's id; one is
 * a Google Analytics 4 tag whose id is in its settings.
 */
export const CONTAINER = [
  "// An invented container for the tests",
  '(function(){var data={"resource":{"version":"4","macros":[],"tags":[',
  '{"function":"__html","vtp_html":"\\x3cscript\\x3e!function(f,b,e,v){}(window,document,\\x27script\\x27,\\x27https:\\/\\/connect.facebook.net\\/en_US\\/fbevents.js\\x27);fbq(\\x27init\\x27,\\x27123456789012345\\x27);\\x3c\\/script\\x3e","tag_id":3},',
  '{"function":"__gaawc","vtp_measurementId":"G-MEAD0W4K1Z","tag_id":4}',
  "]}};})();",
].join("\n");

/** A booking page that loads the container with Tag Manager's standard snippet and has a booking form. */
export const bookingPage = (title: string, origin = "https://tideline-coaching.example"): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="canonical" href="${origin}/book">
<meta property="og:image" content="${origin}/og.png">
<script>(function(w,d,s,l,i){w[l]=w[l]||[];var f=d.getElementsByTagName(s)[0],j=d.createElement(s);j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GTM-ABC1234');</script>
</head><body><header><h1>Book a call</h1></header><main id="main">
<p>Book a first call with an invented coach who helps people change careers without starting again from the bottom. The call is thirty minutes, it is free, and it is only a conversation about where you are now and where you would like to be in a year. Tell us your name and the best number to reach you, and the coach will ring at the time you choose. Nothing on this page describes a real business, and nothing you type here goes anywhere, because the coach exists only in Gaugeline's tests.</p>
<form action="${origin}/book" method="post"><label>Name <input name="name"></label><label>Phone <input name="phone"></label><button type="submit">Book</button></form>
</main></body></html>`;

/** What a transport answers: a status and a body, for GET and HEAD. */
export const answer = (status: number, type: string, body: string, method: string) =>
  Promise.resolve({
    status,
    headers: { "content-type": type },
    body: Readable.from(method === "HEAD" ? [] : [Buffer.from(body)]),
  });

/** Serve the container file at www.googletagmanager.com, as `others` for a site transport. */
export function containerHost(
  container: { status: number; body?: string } = { status: 200, body: CONTAINER },
): Transport {
  return (url, req) =>
    url.hostname === "www.googletagmanager.com" && url.pathname === "/gtm.js"
      ? answer(container.status, "application/javascript", container.body ?? "", req.method)
      : answer(404, "text/plain", "not found", req.method);
}
