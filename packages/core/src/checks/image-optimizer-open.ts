import { defineCheck, type Finding } from "../model.js";
import {
  buildProbe,
  describeOptimizer,
  optimizerLabel,
  findOptimizerAddresses,
  pickAddress,
  probeRefusal,
} from "../images/optimizers.js";
import { askOptimizer } from "../images/probe.js";
import { byOptimizer, claim } from "../images/shared.js";
import type { PageSnapshot } from "../snapshot.js";
import { isHtmlPage } from "./page.js";

/** Why a run without consent did not ask. Reads after "could not be checked:". */
export const NO_CONSENT_REASON =
  "this check asks the site's image address to fetch one outside image, so it runs only with --owner-consent (or gaugeline.consent.json), on sites you own or have permission to test";

export const imageOptimizerOpen = defineCheck<PageSnapshot>({
  id: "image-optimizer-open",
  size: "M",
  done: "The image address answers 400, 403 or 404 for a picture on a host that is not in your image list.",
  estimateChanges:
    "Closing the allowlist is one settings change, then a rebuild. If pictures come from many hosts, finding that list is the work.",
  area: "Security & email",
  severity: "high",
  title: "Your image address fetched a picture from a website you did not list",
  what: "The site's image address (/_next/image, /_vercel/image, /_ipx/, /_image or /.netlify/images) fetched an image from the address you chose for the test, on a host that is not one of your image hosts, and sent it back.",
  why: "Anyone can then use your site to resize and serve images from any address. You pay for the bandwidth and the optimization, your cache fills with other people's pictures, and your site's name sits on an open relay.",
  fix: "Allow only the hosts your pictures come from: remotePatterns or domains in next.config, nuxt.config or astro.config, images in the Vercel project settings, remote_images in netlify.toml. Then rebuild and run the check again.",
  tech: "probing check, off without --owner-consent: needs imageOptimizerProbeUrl in gaugeline.images.json, an https address on a public host you control that is not your own host, not a host your image addresses already use and not a host in the settings files given, never an IP address or a private name; one GET per optimizer the page uses (at most 5 a run), to the site's own origin, with the width and quality the page itself used, no cookie, no redirect followed, 1,024 bytes of the answer read to see whether it is an image and then dropped; 200 with an image content type and image bytes is a finding, 400, 403 and 404 pass, anything else is could not check; the query string and the body are never stored, logged or printed",
  async run(page, ctx) {
    if (!isHtmlPage(page)) return [];
    const addresses = findOptimizerAddresses(page);
    if (addresses.length === 0) return [];
    const origin = new URL(page.finalUrl).origin;
    const at = (path: string) => `${origin}${path}`;
    if (ctx.ownerConsent !== true) {
      for (const group of byOptimizer(addresses).values())
        if (group[0]) ctx.couldNotCheck?.(at(group[0].path), NO_CONSENT_REASON);
      return [];
    }
    const fetcher = ctx.fetcher;
    if (!fetcher) return [];
    const probeUrl = ctx.imageSettings?.probeUrl;
    const seenHosts = addresses.flatMap((a) => (a.sourceHost ? [a.sourceHost] : []));
    const settingsText = ctx.imageSettings?.settings.map((s) => s.text).join("\n");
    const findings: Finding[] = [];
    for (const group of byOptimizer(addresses).values()) {
      const picked = pickAddress(group);
      if (!picked) continue;
      const where = at(picked.path);
      const kind = describeOptimizer(picked.optimizer);
      if (!probeUrl) {
        ctx.couldNotCheck?.(
          where,
          `no imageOptimizerProbeUrl is set in gaugeline.images.json, and Gaugeline never chooses an address of its own for ${kind}`,
        );
        continue;
      }
      const refusal = probeRefusal(probeUrl, {
        siteHost: new URL(origin).hostname,
        seenHosts,
        ...(settingsText ? { settingsText } : {}),
      });
      if (refusal) {
        ctx.couldNotCheck?.(where, refusal);
        continue;
      }
      const target = buildProbe(origin, picked, probeUrl);
      if (!target) {
        ctx.couldNotCheck?.(
          where,
          `the page's own ${kind} address gives no width to ask with, and Gaugeline does not guess one`,
        );
        continue;
      }
      if (!claim(fetcher, `${this.id}:${picked.optimizer}`)) continue;
      const outcome = await askOptimizer(fetcher, target);
      if (outcome.kind === "unclear") {
        ctx.couldNotCheck?.(where, outcome.reason);
        continue;
      }
      if (outcome.kind === "closed") continue;
      const used = new URL(probeUrl);
      findings.push({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `The ${optimizerLabel(picked.optimizer)} image address answered ${outcome.status} with an image fetched from ${used.host}${used.pathname}, a host that is not in your image list: anyone can use your site to resize and serve images from any address`,
        url: where,
      });
    }
    return findings;
  },
});
