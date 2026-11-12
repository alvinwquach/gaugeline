import { describePartial } from "../adapters/collect.js";
import type { PayloadReading } from "../adapters/payload-read.js";
import { CheckRegistry, defineCheck, type Finding } from "../model.js";

/**
 * The check that needs Payload's own answers: whether a visitor with no key can read a collection the owner marked
 * private. Pure over a PayloadReading (collection slugs and counts, never a field or a document), so the same site
 * gives the same findings. Everything in a reading came from a platform: it is printed as text and never acted on.
 */
const PROBING_NOTE =
  "this check asks Payload for collections you marked private, as a visitor with no key, so it runs only with --owner-consent (or gaugeline.consent.json), on sites you own or have permission to test";

export const payloadCollectionPublic = defineCheck<PayloadReading>({
  id: "payload-collection-public",
  size: "S",
  done: "A visitor with no key cannot list a single document of any collection you marked private.",
  estimateChanges:
    "Usually one change in the collection's config: replace a read rule that returns true with one that needs a signed-in user. Allow longer if the front end reads that collection with no key and needs a server-side read first.",
  area: "Security & email",
  severity: "high",
  title: "A Payload collection marked private is readable by visitors with no key",
  what: "gaugeline.adapters.json marks a collection private (privateCollections), and a plain GET of its list with no key is answered with documents.",
  why: "Anyone who guesses the route can read the collection as data: orders, enquiries, customer notes, prices before they are announced. A search engine or scraper may already have it.",
  fix: "In the collection's config, change access.read from a function that returns true to one that requires a signed-in user (it checks req.user), or narrow it with a query that returns only what is public. If the front end needs the data, read it on the server with the Local API. If the collection is meant to be public, take it out of privateCollections.",
  tech: `probing check, off without --owner-consent: ${PROBING_NOTE}; only for the collections named in the settings' privateCollections; per collection one GET of {PAYLOAD_URL}/{slug}?limit=1&page=1&depth=0&select[id]=true with no Authorization header, no cookie and nothing the fetcher adds per address, redirects not followed; a 200 whose body has a docs list with at least one document is the finding (its count is the reported totalDocs, or "at least 1" when none is reported); a 200 with no documents is could-not-check (a visitor may read it and there is nothing to count); a 403 is a closed collection only when its body is Payload's own refusal (errors[0].message is "You are not allowed to perform this action."), otherwise it is could-not-check (a firewall or CDN page answers 403 too, and a site in another language answers with a translated message); Payload looks a collection up before it looks at access, so a collection that does not exist is a 404 and is could-not-check with the spelling named, never closed; a pass means no public read of the list was seen, not that nothing is public (a collection can allow single documents by id, or other routes, and a closed list can still be open through GraphQL); any other answer is could-not-check; the answer is read as a count and nothing else, and a finding is a collection slug and a count, never a document`,
  run(r, ctx) {
    if (!r.ownerConsent) {
      ctx.couldNotCheck?.(
        r.site,
        `not asked: ${PROBING_NOTE}. Run with --owner-consent to check which Payload collections visitors can read.`,
      );
      return [];
    }
    if (r.markedPrivate.length === 0) {
      ctx.couldNotCheck?.(
        r.site,
        "not asked: no collection is marked private. A Payload collection is often public on purpose, so Gaugeline asks only for the collections named in privateCollections in gaugeline.adapters.json.",
      );
      return [];
    }
    if (r.partial) ctx.couldNotCheck?.(r.site, describePartial(r.partial));
    const out: Finding[] = [];
    for (const c of r.publicCollections) {
      if (c.state === "unread") {
        ctx.couldNotCheck?.(r.site, `${c.type}: not read (${c.reason ?? "no reason given"})`);
        continue;
      }
      if (c.state === "empty") {
        ctx.couldNotCheck?.(
          r.site,
          `${c.type}: Payload answered a visitor with no documents, so there was nothing to count. The collection may be empty, or a visitor may read it and its read rule may match nothing.`,
        );
        continue;
      }
      if (c.state !== "public") continue;
      out.push({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `${c.type}: a request with no key listed ${c.exact ? c.listed : `at least ${c.listed}`} ${c.listed === 1 ? "document" : "documents"}, and gaugeline.adapters.json marks the collection private`,
        url: r.site,
      });
    }
    // A collection that was marked and is missing from the answer was not asked (the read stopped first).
    const asked = new Set(r.publicCollections.map((c) => c.type));
    for (const name of r.markedPrivate)
      if (!asked.has(name) && !r.partial) ctx.couldNotCheck?.(r.site, `${name}: not asked.`);
    return out;
  },
});

export const PAYLOAD_CHECKS = [payloadCollectionPublic] as const;

/** The checks a Payload read runs. They are not in the page registry: they read the CMS, not one page. */
export function createPayloadRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const check of PAYLOAD_CHECKS) registry.register(check);
  return registry;
}
