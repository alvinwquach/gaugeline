import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import { notReadReason } from "./scan.js";
import { lineOf, sourceUrl, webhookHandlers } from "./source-scan.js";

/**
 * FF-11 (advice): a Sanity publish webhook receiver that clears the cache for a document id and
 * nothing in it skips the ids Sanity gives a draft (`drafts.`) or a content release version
 * (`versions.`). A draft that is saved then clears the live cache too: wasted purges. Static: it reads
 * the code, it never sends a webhook.
 *
 * Not sure is not a pass: a receiver that clears the cache without ever reading an id may be fine
 * (the webhook is set to send published documents only, in Sanity, where Gaugeline cannot look), so it
 * is could-not-check.
 *
 * // [docs] next@16.4.1 > revalidateTag ("marks the tagged data as stale") - https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/03-api-reference/04-functions/revalidateTag.mdx (supports what a clear is, not the rest)
 * // [GC] no source found (uncited): that Sanity gives a draft an id starting with drafts. and a release version one starting with versions., and that a webhook is sent for them. Sanity's documentation was not reachable; the check text states what the code does and not what Sanity sends.
 */
const ID = "webhook-purges-draft-ids";

/** A call that clears the Next.js cache. */
const PURGE = /\b(?:revalidateTag|revalidatePath|updateTag)\s*\(/;
/** The document id, by the names a webhook projection usually gives it. */
const ID_READ = /\b(?:_id|documentId|docId)\b|\bids\b/;
/** What shows the code knows a draft or version id from a published one (strings kept, comments blanked). */
const GUARD =
  /["'`]\s*(?:drafts|versions)\.|\b(?:drafts|versions)\\\.|\b(?:getPublishedId|isDraftId|isVersionId|isPublishedId)\b/;

export const webhookPurgesDraftIds = defineCheck<LocalSourceInput>({
  id: ID,
  size: "S",
  done: "The receiver returns before it clears the cache for an id that starts with drafts. or versions., or the webhook is set to send published documents only.",
  estimateChanges:
    "One early return in one route file; a few minutes more if the receiver is copied into several routes or the webhook's trigger is changed in Sanity.",
  area: "Visitors",
  severity: "low",
  title: "A publish webhook clears the cache for draft ids too",
  what: "The code that receives a Sanity publish webhook reads the document id and clears the cache, and nothing in it skips an id that starts with drafts. or versions.",
  why: "Sanity keeps a draft under an id that starts with drafts. (and a content release version under versions.). If the webhook is also sent for those, every saved draft clears the cache: the site refetches content no visitor can see, and an editor typing for an afternoon keeps the cache cold. (Gaugeline has not confirmed from Sanity's documentation which documents a webhook is sent for.)",
  fix: "Return early, before the cache is cleared, when the id starts with drafts. or versions.; or set the webhook in Sanity to send published documents only. Either is enough.",
  tech: "reads the code files of the folder named, never runs them; a receiver is a file that imports @sanity/webhook or next-sanity/webhook, reads the sanity-webhook-signature header, or is a route that revalidates behind a secret; a call to revalidateTag, revalidatePath or updateTag in a receiver that reads the document id (_id, documentId, docId, ids) and has no mention of drafts. or versions., and no getPublishedId, isDraftId, isVersionId or isPublishedId call, is a finding at the first such call; a receiver that clears the cache and never reads an id is could-not-check, because the webhook's own settings in Sanity may already exclude drafts; the finding names the file and the line, never an id, a tag or the secret",
  run(input, ctx) {
    const url = sourceUrl(input);
    const out: Finding[] = [];
    for (const h of webhookHandlers(input)) {
      const purge = PURGE.exec(h.scanned.bare);
      if (purge === null || GUARD.test(h.scanned.code)) continue;
      if (!ID_READ.test(h.scanned.bare)) {
        ctx.couldNotCheck?.(
          url,
          `${h.path} clears the cache without reading the document id, so Gaugeline cannot tell whether draft ids reach it: that depends on the webhook's settings in Sanity.`,
        );
        continue;
      }
      const line = lineOf(h.scanned.bare, purge.index);
      out.push({
        checkId: ID,
        severity: "low",
        title: this.title,
        evidence: `${h.path}:${line}: this receiver reads the document id and clears the cache, and nothing in it skips an id that starts with drafts. or versions.`,
        url,
        source: { file: h.path, line },
      });
    }
    const unread = notReadReason(input.tree);
    if (out.length === 0 && unread !== undefined) ctx.couldNotCheck?.(url, unread);
    return out;
  },
});
