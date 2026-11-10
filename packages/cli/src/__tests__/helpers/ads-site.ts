import { Readable } from "node:stream";
import type { Transport } from "@gaugeline/core";

/**
 * Stand-ins for the invented tapas bar (tapas-bar.example) the ads fixtures link to, so a test of
 * `gaugeline ads` makes its requests without a network. Reserved names never reach DNS.
 */
const answer = (status: number, headers: Record<string, string> = {}) =>
  Promise.resolve({
    status,
    headers: { "content-type": "text/html", ...headers },
    body: Readable.from([Buffer.from("<!doctype html><title>Tapas Bar</title>")]),
  });

/** Every page answers 200 and keeps the query: nothing to report. */
export const okSite: Transport = () => answer(200);

/**
 * The gift cards page redirects to /shop/gift-cards and drops the query, as an old rule written by
 * hand often does; every other page answers 200. One finding, on one page.
 */
export const tapasSite: Transport = (url) =>
  url.pathname === "/gift-cards" ? answer(301, { location: "/shop/gift-cards" }) : answer(200);

/** Records every request it is asked for, then answers like okSite. */
export function recordingSite(): { transport: Transport; urls: string[]; methods: string[] } {
  const urls: string[] = [];
  const methods: string[] = [];
  return {
    urls,
    methods,
    transport: (url, req) => {
      urls.push(url.href);
      methods.push(req.method);
      return answer(200);
    },
  };
}
