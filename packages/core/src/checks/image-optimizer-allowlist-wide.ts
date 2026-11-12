import { defineCheck } from "../model.js";
import { findOptimizerAddresses } from "../images/optimizers.js";
import { claim, noteNoSettings, settingsIssues } from "../images/shared.js";
import type { PageSnapshot } from "../snapshot.js";
import { isHtmlPage } from "./page.js";

export const imageOptimizerAllowlistWide = defineCheck<PageSnapshot>({
  id: "image-optimizer-allowlist-wide",
  size: "S",
  done: "The image settings list the exact hosts the site fetches pictures from, with no wildcard that matches every host.",
  estimateChanges:
    "Replacing a wildcard with the real image hosts is one settings change. If pictures come from many hosts, finding that list is the work.",
  area: "Security & email",
  severity: "high",
  title: "Your image settings let the image address fetch from any website",
  what: "The image settings you gave (next.config, nuxt.config, astro.config or netlify.toml) allow a wildcard host, a pattern with no host, or a match-everything expression, so the site's image address will fetch, resize and serve a picture from any address a visitor puts in it.",
  why: "Anyone can then use your site to resize and serve images from any address. You pay for the bandwidth and the optimization, your cache fills with other people's pictures, and your site's name sits on an open relay.",
  fix: "List the exact hosts your pictures come from (and a path prefix where you can) in remotePatterns, domains or remote_images, and remove the wildcard.",
  tech: "Not a probing check: no request is made. Reads the files named in settingsFiles of gaugeline.images.json as text (never run) and reports a hostname that is only wildcards or a wildcard and a top-level name, a remotePatterns entry with no hostname (an https-only pattern), a domains list holding a wildcard, and a Netlify remote_images expression that matches every address. A page that uses /_next/image, /_vercel/image, /_ipx/, /_image or /.netlify/images with no settings given is could not check. A statement about the file, not about the running site",
  async run(page, ctx) {
    if (!isHtmlPage(page)) return [];
    const origin = new URL(page.finalUrl).origin;
    const cfg = ctx.imageSettings;
    if (!cfg || cfg.settings.length === 0) {
      noteNoSettings(ctx, origin, findOptimizerAddresses(page));
      return [];
    }
    if (!claim(cfg, this.id)) return [];
    return settingsIssues(cfg)
      .filter((i) => i.kind === "wide")
      .map((i) => ({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `${i.file} line ${i.line}: ${i.entry} lets the image address fetch from any host`,
        url: `${origin}/`,
      }));
  },
});
