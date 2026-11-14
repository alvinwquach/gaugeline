import * as cheerio from "cheerio";
import type { CheckContext } from "../model.js";
import { defineCheck } from "../model.js";
import {
  animatedLayoutProperties,
  hasLowEndFallback,
  heavyMotionKinds,
  heroImage,
  layoutThrashLoops,
  startGate,
  webglEvidence,
} from "../perf-causes/detect.js";
import type { ScriptRead } from "../scripts.js";
import type { PageSnapshot } from "../snapshot.js";
import { escapeInvisible } from "./hidden-text/escape.js";
import { isHtmlPage } from "./page.js";

const clip = (text: string): string => escapeInvisible(text, 160);

/** An image is a hero, worth asking to be prioritised, when its width attribute says it is shown this wide or wider. */
const HERO_WIDTH = 800;

const htmlOf = (page: PageSnapshot): string => page.hops.at(-1)?.body ?? "";

/** The page's inline scripts as the snapshot kept them (the start of each). */
const inlineCode = (page: PageSnapshot): string[] =>
  (page.scriptTags ?? []).flatMap((t) => (t.inline ? [t.inline] : []));

/** The page's own `<style>` text. External stylesheets are not read: that would be a request of its own. */
function inlineCss(html: string): string {
  const $ = cheerio.load(html);
  return $("style")
    .map((_, el) => $(el).text())
    .get()
    .join("\n");
}

/** The site's own script files, already fetched for the key check and shared; never a new request. */
async function siteScripts(ctx: CheckContext): Promise<ScriptRead[]> {
  try {
    return (await ctx.scripts?.()) ?? [];
  } catch {
    return [];
  }
}

/** Says, once, which script files could not be read or were cut, and returns whether all were read whole. */
function allScriptsRead(
  reads: readonly ScriptRead[],
  url: string,
  ctx: CheckContext,
  what: string,
): boolean {
  const bad = reads.filter((r) => r.status === null || r.truncated);
  if (bad.length === 0) return true;
  const first = bad[0] as ScriptRead;
  ctx.couldNotCheck?.(
    url,
    `${bad.length === 1 ? `A script of the site (${clip(first.url)})` : `${bad.length} scripts of the site`} ${first.status === null ? "could not be read" : "was longer than is read, so only its start was"}, so ${what}.`,
  );
  return false;
}

const list = (items: readonly string[]): string =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

export const perfWebglAutostart = defineCheck<PageSnapshot>({
  id: "perf-webgl-autostart",
  size: "M",
  done: "The 3D scene starts only after a click, tap or scroll into view, or the page shows a still picture first; running Gaugeline again finds no scene that starts at load without a start step.",
  estimateChanges:
    "A few hours to add a start step or a still poster and load the scene's library only when it is asked for; more when the scene is the whole front page.",
  area: "Visitors",
  severity: "medium",
  title: "A 3D scene starts as soon as the page loads",
  what: "The page sets up a 3D (WebGL) scene, with a library such as three.js, Babylon.js or PlayCanvas or a WebGL call in its code, and nothing asks the visitor to click or tap to start it.",
  why: "A 3D scene downloads a large library and models and keeps the graphics chip busy from the first second, on every phone, whether or not the visitor wants it. It delays the page's first paint and interaction and drains batteries, and a visitor on a slow connection or an old phone gets the cost and no benefit.",
  fix: "Show a still picture first and start the scene when the visitor taps it or scrolls it into view, load the 3D library only then (a dynamic import), and skip it for visitors who ask for less data or motion.",
  tech: "Plain rules over the page as sent and its own scripts. A 3D library by its script address (three, babylon, playcanvas, react-three, spline) beside a canvas element in the HTML, or a WebGL call in an inline script (a WebGLRenderer, a webgl or webgl2 context), counts as a scene set up at load; with --renderer playwright the canvas must be in the rendered page, whose size is reported. Words that ask for a click, tap or press to start, play or enter anywhere on the page make it a scene that waits for the visitor, and nothing is reported. Gaugeline gives the page no input, so a scene set up at load has started without any",
  async run(page, ctx) {
    if (!isHtmlPage(page)) return [];
    const html = htmlOf(page);
    const code = [...inlineCode(page), ...(await siteScripts(ctx)).map((r) => r.text)];
    const fromCode = webglEvidence({ scripts: [], code });
    const fromScript = webglEvidence({ scripts: page.scripts, code: [] });
    if (!fromCode && !fromScript) return [];
    let canvas = /<canvas\b/i.test(html);
    let size: string | undefined;
    let text = cheerio.load(html)("body").text();
    if (ctx.render) {
      const r = await ctx.render({ expose: { html: true, text: true } });
      if (r.kind === "rendered" && r.html !== undefined) {
        const $ = cheerio.load(String(r.html));
        const first = $("canvas").first();
        canvas = first.length > 0;
        const w = first.attr("width");
        const h = first.attr("height");
        size = canvas
          ? `${w && h ? ` of ${clip(w)} by ${clip(h)}` : ""} in the rendered page`
          : undefined;
        text = $("body").text();
      }
    }
    if (startGate(text)) return [];
    if (!(fromCode || canvas)) return [];
    const what = fromCode ? `${clip(fromCode)} is called` : `${clip(fromScript ?? "")} is loaded`;
    const canvasPart =
      size !== undefined
        ? ` and the page draws a canvas${size}`
        : fromCode
          ? ""
          : " and the page has a canvas";
    return [
      {
        checkId: "perf-webgl-autostart",
        severity: "medium",
        title: this.title,
        evidence: `A 3D scene starts as soon as the page loads: ${what}${canvasPart}, and no "click to start" or "tap to enter" step was found, so every visitor pays for it before any input.`,
        url: clip(page.finalUrl),
      },
    ];
  },
});

export const perfLcpImage = defineCheck<PageSnapshot>({
  id: "perf-lcp-image",
  size: "S",
  done: "The page's first large image is not lazy-loaded, is preloaded or marked fetchpriority high, and is asked for at about the width it is shown.",
  estimateChanges:
    "Minutes for one attribute on the hero image; an hour if the image component has to be changed to pass it.",
  area: "Visitors",
  severity: "medium",
  title: "The page's first large image is lazy, late or oversized",
  what: "The first large content image of the page, which is usually the largest paint, is lazy-loaded, or is neither preloaded nor marked fetchpriority high, or is asked for at more than twice the width it is shown.",
  why: "The largest paint is the number search engines and visitors judge a page's speed by. An image that the browser is told to wait for, that it finds late, or that is several times larger than needed delays it directly.",
  fix: 'Remove loading=lazy from the first large image, add fetchpriority="high" (or a preload link for it), and ask for it at about the width it is shown: a srcset and sizes, and a width parameter no larger than needed.',
  tech: "The first img in the page's HTML outside a header, nav or footer, not named like a logo or icon and not under 300 by 100 pixels. Medium when it has loading=lazy, or when a width parameter or a Next.js image address asks for at least twice the width attribute and 1600 pixels (2560 when there is no width attribute); low when it is written 800 pixels wide or more and lacks both a preload link for its address and fetchpriority high (an image with no width attribute, or a narrower one, is not asked to be prioritised: most pages have one). This is a guess at which image the browser picks, which is why the finding says the first large image; it fetches no image and the same page gives the same finding",
  run(page) {
    if (!isHtmlPage(page)) return [];
    const hero = heroImage(htmlOf(page), page.finalUrl);
    if (!hero) return [];
    const problems: string[] = [];
    let medium = false;
    if (hero.lazy) {
      problems.push("is lazy-loaded, so the browser waits to fetch it");
      medium = true;
    } else if (
      !hero.priorityHigh &&
      !hero.preloaded &&
      hero.width !== undefined &&
      hero.width >= HERO_WIDTH
    ) {
      problems.push(
        'is not preloaded and has no fetchpriority="high", so the browser finds it late',
      );
    }
    const asked = hero.requestedWidth;
    if (
      asked !== undefined &&
      (hero.width === undefined ? asked >= 2560 : asked >= 1600 && asked >= hero.width * 2)
    ) {
      problems.push(
        `is asked for at ${asked} pixels wide${hero.width === undefined ? "" : ` but shown ${hero.width} wide`}`,
      );
      medium = true;
    }
    if (problems.length === 0) return [];
    return [
      {
        checkId: "perf-lcp-image",
        severity: medium ? "medium" : "low",
        title: this.title,
        evidence: `The first large image, ${clip(hero.src)}, ${problems.join("; and ")}: it is probably what the page's largest paint waits for.`,
        url: clip(page.finalUrl),
      },
    ];
  },
});

export const perfAnimationReflow = defineCheck<PageSnapshot>({
  id: "perf-animation-reflow",
  size: "M",
  done: "Animations move transform and opacity only, and no animation loop reads a layout value after setting a style in the same frame.",
  estimateChanges:
    "An hour per animation to move it to transform or opacity; a loop that reads and writes layout has to be restructured to read first and write after.",
  area: "Visitors",
  severity: "low",
  title: "An animation makes the browser lay the page out on every frame",
  what: "The page's own styles animate layout properties (position, size, margin, padding, font size) or transition all, or one of its scripts has an animation loop that reads a layout value and then sets a style.",
  why: "Layout is the most expensive thing a browser does each frame. Animating it, or reading it right after changing it (a forced reflow), makes the page stutter and keeps the main thread busy, which delays everything a visitor taps.",
  fix: "Animate transform and opacity instead of top, left, width and height, name the properties a transition changes instead of all, and in an animation loop read layout values first and write styles after, once per frame.",
  tech: "Plain rules over the page's inline styles and its own script files (each fetched once for the key check and shared, never a request of this check's own). Layout properties in a keyframes rule or a transition (top, left, width, height, margins, paddings, font-size, line-height, all) are low. A script text with a requestAnimationFrame call within 500 characters of both a layout read (offsetWidth, clientHeight, scrollTop, getBoundingClientRect, getComputedStyle) and a style write is medium and counted once per script. Stylesheets in separate files and scripts from other sites are not read; a script that cannot be read is could-not-check",
  async run(page, ctx) {
    if (!isHtmlPage(page)) return [];
    const reads = await siteScripts(ctx);
    allScriptsRead(reads, page.finalUrl, ctx, "an animation loop in it was not looked for");
    const props = animatedLayoutProperties(inlineCss(htmlOf(page)));
    const loops = layoutThrashLoops([...inlineCode(page), ...reads.map((r) => r.text)]);
    if (props.length === 0 && loops === 0) return [];
    const parts: string[] = [];
    if (props.length > 0)
      parts.push(
        `The page's own styles animate layout properties (${props.join(", ")}), so each frame makes the browser lay the page out again. Stylesheets in separate files are not read.`,
      );
    if (loops > 0)
      parts.push(
        `${loops} ${loops === 1 ? "script has" : "scripts have"} an animation loop that reads a layout value and then sets a style, so each frame makes the browser lay the page out twice.`,
      );
    return [
      {
        checkId: "perf-animation-reflow",
        severity: loops > 0 ? "medium" : "low",
        title: this.title,
        evidence: parts.join(" "),
        url: clip(page.finalUrl),
      },
    ];
  },
});

const WITH_ARTICLE: Record<string, string> = {
  "3D scene": "a 3D scene",
  "autoplaying video": "an autoplaying video",
  "animation library": "an animation library",
};

export const perfNoLowendFallback = defineCheck<PageSnapshot>({
  id: "perf-no-lowend-fallback",
  size: "M",
  done: "The heavy parts (3D, autoplaying video, an animation library) are skipped or lightened for a visitor whose browser asks to save data or reports little memory, few cores or a slow connection.",
  estimateChanges:
    "Half a day to read the data saver and device hints and swap the heavy part for a still picture; more if the page is built around the heavy part.",
  area: "Visitors",
  severity: "low",
  title: "A heavy page has no Save-Data or low-end-device fallback",
  what: "The page loads a 3D scene, an autoplaying video or an animation library, and nothing in its own scripts or styles reads the visitor's data saver, device memory, core count or connection type.",
  why: "The visitors who most need a lighter page are on small phones and slow or capped connections, and they get exactly the same heavy load as someone on a desktop. A page that looks at the hints the browser already offers can send them a still picture instead.",
  fix: "Read navigator.connection.saveData, navigator.deviceMemory, navigator.hardwareConcurrency or the prefers-reduced-data media query before starting the heavy part, and show a still picture or a lighter version when they say the visitor is low on data or power.",
  tech: "Plain rules. Heavy means a 3D library or WebGL call, a video tag with autoplay, or a script named gsap, lottie, anime or framer-motion. The page's own inline scripts and styles and its own script files (already fetched once for the key check, never a new request) are searched for saveData, Save-Data, prefers-reduced-data, deviceMemory, hardwareConcurrency and effectiveType. None found is low. Scripts from other sites and separate stylesheet files are not read, so a fallback only there is not seen; a script that cannot be read, or was cut, makes the check could-not-check",
  async run(page, ctx) {
    if (!isHtmlPage(page)) return [];
    const html = htmlOf(page);
    const reads = await siteScripts(ctx);
    const code = [...inlineCode(page), ...reads.map((r) => r.text)];
    const kinds = heavyMotionKinds({ html, scripts: page.scripts, code });
    if (kinds.length === 0) return [];
    if (hasLowEndFallback([...code, inlineCss(html), html])) return [];
    if (!allScriptsRead(reads, page.finalUrl, ctx, "a fallback in it may have been missed"))
      return [];
    return [
      {
        checkId: "perf-no-lowend-fallback",
        severity: "low",
        title: this.title,
        evidence: `The page loads ${list(kinds.map((k) => WITH_ARTICLE[k] ?? k))} and nothing in its own scripts or styles reads the visitor's data saver (Save-Data), device memory, core count or connection type, so a small phone on a slow connection gets the same heavy load as a desktop. Scripts from other sites are not read.`,
        url: clip(page.finalUrl),
      },
    ];
  },
});

export const PERF_CAUSE_CHECKS = [
  perfWebglAutostart,
  perfLcpImage,
  perfAnimationReflow,
  perfNoLowendFallback,
] as const;
