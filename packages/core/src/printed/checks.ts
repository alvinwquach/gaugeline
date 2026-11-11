import { CheckRegistry, defineCheck, type Finding, type Size } from "../model.js";
import {
  PRINTED_CHECK_IDS,
  PRINTED_TITLES,
  type PrintedCheckId,
  type PrintedResult,
} from "./check.js";

/** What each check of a table says about itself: the same fields defineCheck reads. */
interface CheckText {
  severity: Finding["severity"];
  what: string;
  why: string;
  fix: string;
  tech: string;
  size: Size;
  done: string;
  estimateChanges: string;
}

/** What a printed check reads: checkPrinted's result over the register, precomputed. */
export interface PrintedCheckInput {
  printed: PrintedResult;
  file: string;
}

const TEXT: Record<PrintedCheckId, CheckText> = {
  "printed-dead": {
    size: "S",
    done: "Each printed address lands on a live page, on the scheme that was printed.",
    estimateChanges:
      "One redirect per address. Printed material cannot be changed, so each address has to be covered.",
    severity: "high",
    what: "A printed address (a QR code, a flyer, a short link) ends in a 4xx or 5xx, or no longer answers on the http:// that was printed.",
    why: "A printed code can't be reprinted when a page moves: everyone who scans it gets an error.",
    fix: "Add a redirect from the printed address to the page it was for, and answer on http if http was printed.",
    tech: "The printed URL fetched as printed with GET; the trail's last hop is 400 or above. A printed http:// that refuses the connection while https:// answers is reported here",
  },
  "printed-wrong-destination": {
    size: "S",
    done: "Each printed address lands on its expected page with no stop on the way.",
    estimateChanges: "A short link made by a third party may need its own settings changed.",
    severity: "high",
    what: "A printed address lands somewhere other than its expectedDestination, or stops on an interstitial page that sends people on.",
    why: "People scanned a code for one thing and got another, or a page they have to wait through.",
    fix: "Point the printed address's redirect at the expected page, and make a short link redirect with a 301 rather than show its own page.",
    tech: "The trail's final address against expectedDestination (host without www, path without trailing slash). A 200 with a meta refresh or a location assignment and no redirect is an interstitial",
  },
  "printed-to-home": {
    size: "S",
    done: "The printed address redirects to the page that replaced its original, and its expectedDestination is in the register.",
    estimateChanges: "Several printed addresses each need their own redirect.",
    severity: "medium",
    what: "A printed link to a page deeper than the home page now lands on the home page.",
    why: "The classic lazy redirect after a restructure: the visitor who scanned for the menu has to find it again.",
    fix: "Redirect the printed address to the page that replaced the one it was printed for, and add its expectedDestination to the register.",
    tech: "No expectedDestination; the printed path isn't / and the trail ends on /",
  },
  "printed-tags-lost": {
    size: "S",
    done: "The redirect passes the query string on, and the scan reaches the page with its tags.",
    estimateChanges: "A short-link service may need its own setting.",
    severity: "medium",
    what: "A printed address's utm_ (or other configured) parameters are gone by the time it reaches its page.",
    why: "Scans of that table tent or flyer can't be counted: the campaign looks like it did nothing.",
    fix: "Pass the query string on in the redirect.",
    tech: "Parameters on the printed URL whose names start with a tag prefix (utm_ by default) and are missing from the final address",
  },
  "printed-chain": {
    size: "S",
    done: "The printed address redirects once, straight to its page.",
    estimateChanges: "Rules in a short-link service, the host and the app each need checking.",
    severity: "low",
    what: "A printed address takes more than two redirects to land.",
    why: "Every hop is a wait on a phone, often on a weak signal, and one broken hop breaks the code.",
    fix: "Redirect the printed address straight to its page.",
    tech: "More than two 3xx in the trail; the trail is in the evidence",
  },
};

export const PRINTED_CHECKS = PRINTED_CHECK_IDS.map((id) =>
  defineCheck<PrintedCheckInput>({
    id,
    area: "Launch day",
    title: PRINTED_TITLES[id],
    ...TEXT[id],
    run(input, ctx) {
      for (const c of input.printed.couldNotCheck) ctx.couldNotCheck?.(c.url, c.reason);
      return input.printed.findings.filter((f) => f.checkId === id);
    },
  }),
);

export function createPrintedRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const c of PRINTED_CHECKS) registry.register(c);
  return registry;
}
