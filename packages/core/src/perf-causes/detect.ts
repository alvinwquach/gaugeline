import * as cheerio from "cheerio";
import { nextImage, widthParam } from "../checks/images/refs.js";

/**
 * Plain rules over a page's HTML, its inline scripts and styles and its own JavaScript files (PERF-03): the causes
 * of a slow or heavy page that a framework tends to leave behind. Nothing here runs a script or asks for an
 * address. Everything read is data from the site: it is matched, never obeyed, and only counts and short names
 * come out.
 */

const NOT_CONTENT = /logo|icon|sprite|avatar|pixel|tracking|spacer|blank|1x1|badge|emoji/i;

export interface HeroImage {
  /** Absolute address as written. */
  src: string;
  width?: number;
  lazy: boolean;
  priorityHigh: boolean;
  hasSrcset: boolean;
  preloaded: boolean;
  /** The width the address asks for (a `w=` parameter or a Next.js image address), when it says. */
  requestedWidth?: number;
}

const toNumber = (v: string | undefined): number | undefined => {
  const n = v === undefined ? NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
};

function absolute(url: string, base: string): string | undefined {
  try {
    return new URL(url, base).href;
  } catch {
    return undefined;
  }
}

/**
 * The first large content image of the page, which is what the largest paint is most often: not in a header, nav or
 * footer, not named like a logo or an icon, not tiny. It is a guess about which image the browser will pick, and
 * the finding says "first large image" for that reason.
 */
export function heroImage(html: string, base: string): HeroImage | undefined {
  const $ = cheerio.load(html);
  const preloads: string[] = [];
  $('link[rel~="preload"]').each((_, el) => {
    if (($(el).attr("as") ?? "").toLowerCase() !== "image") return;
    const href = $(el).attr("href");
    if (href) preloads.push(absolute(href, base) ?? href);
    for (const part of ($(el).attr("imagesrcset") ?? "").split(",")) {
      const first = part.trim().split(/\s+/)[0];
      if (first) preloads.push(absolute(first, base) ?? first);
    }
  });
  let found: HeroImage | undefined;
  $("img").each((_, el) => {
    if (found) return;
    const img = $(el);
    if (img.closest("header, nav, footer").length > 0) return;
    const src = img.attr("src");
    if (!src || src.startsWith("data:") || NOT_CONTENT.test(src)) return;
    const width = toNumber(img.attr("width"));
    const height = toNumber(img.attr("height"));
    if ((width !== undefined && width < 300) || (height !== undefined && height < 100)) return;
    const abs = absolute(src, base);
    if (!abs) return;
    const requestedWidth = nextImage(abs).width ?? widthParam(abs);
    found = {
      src: abs,
      ...(width === undefined ? {} : { width }),
      lazy: (img.attr("loading") ?? "").toLowerCase() === "lazy",
      priorityHigh: (img.attr("fetchpriority") ?? "").toLowerCase() === "high",
      hasSrcset: (img.attr("srcset") ?? "").trim() !== "",
      preloaded: preloads.includes(abs),
      ...(requestedWidth === undefined ? {} : { requestedWidth }),
    };
  });
  return found;
}

const THREE_D_SCRIPT =
  /(?:^|[/@._-])(?:three(?:\.module)?(?:\.min)?\.js|three@[\d.]+|babylon(?:js)?(?:\.min)?\.js|playcanvas|react-three|r3f|splinetool|spline-viewer|ogl\.js)|\/three\.module/i;
const WEBGL_CODE =
  /new\s+(?:THREE\.)?WebGLRenderer|BABYLON\.Engine|new\s+pc\.Application|getContext\(\s*["'](?:experimental-)?webgl2?["']/;

/** What shows a 3D scene is set up: the script that names it, or the call in code. Undefined when nothing does. */
export function webglEvidence(input: {
  scripts: readonly string[];
  code: readonly string[];
}): string | undefined {
  for (const src of input.scripts) {
    const file = src.split("?")[0]?.split("#")[0] ?? "";
    if (THREE_D_SCRIPT.test(file)) return file.slice(file.lastIndexOf("/") + 1) || file;
  }
  for (const text of input.code) {
    const m = WEBGL_CODE.exec(text);
    if (m) return m[0].replace(/\s+/g, " ").slice(0, 60);
  }
  return undefined;
}

const GATE_WORDS =
  /\b(?:click|tap|press)\b(?:\s+\w+){0,4}?\s+(?:to\s+)?(?:start|play|enter|explore|begin|launch|activate)\b/i;

/** Words that ask the visitor to click, tap or press before something starts. */
export function startGate(text: string): boolean {
  return GATE_WORDS.test(text.slice(0, 20_000));
}

/** What makes a page heavy for a small phone: 3D, autoplaying video, an animation library. */
export function heavyMotionKinds(input: {
  html: string;
  scripts: readonly string[];
  code: readonly string[];
}): string[] {
  const kinds: string[] = [];
  if (webglEvidence({ scripts: input.scripts, code: input.code })) kinds.push("3D scene");
  if (/<video\b[^>]*\bautoplay\b/i.test(input.html)) kinds.push("autoplaying video");
  if (
    input.scripts.some((s) =>
      /(?:^|[/@._-])(?:gsap|lottie|anime|framer-motion)(?:\.min)?\.js/i.test(s.split("?")[0] ?? ""),
    )
  )
    kinds.push("animation library");
  return kinds;
}

const LOW_END =
  /\bsaveData\b|save-data|prefers-reduced-data|\bdeviceMemory\b|\bhardwareConcurrency\b|\beffectiveType\b/i;

/** Whether any text reads the visitor's data saver, device memory, core count or connection type. */
export function hasLowEndFallback(texts: readonly string[]): boolean {
  return texts.some((t) => LOW_END.test(t));
}

const LAYOUT_PROPS = new Set([
  "top",
  "left",
  "right",
  "bottom",
  "width",
  "height",
  "margin",
  "margin-top",
  "margin-left",
  "margin-right",
  "margin-bottom",
  "padding",
  "padding-top",
  "padding-left",
  "padding-right",
  "padding-bottom",
  "font-size",
  "line-height",
  "border-width",
]);

/** The layout properties that keyframes animate, or a transition names (`all` included), once each, in order. */
export function animatedLayoutProperties(css: string): string[] {
  const found = new Set<string>();
  const text = css.slice(0, 500_000);
  for (const block of text.matchAll(/@(?:-webkit-)?keyframes\s+[\w-]+\s*\{/g)) {
    // The block runs to its matching brace; the stop is bounded so a missing brace cannot run on.
    let depth = 1;
    let i = (block.index ?? 0) + block[0].length;
    const start = i;
    for (; i < text.length && depth > 0 && i - start < 20_000; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
    }
    for (const d of text.slice(start, i).matchAll(/([a-z-]+)\s*:/g)) {
      const prop = d[1] ?? "";
      if (LAYOUT_PROPS.has(prop)) found.add(prop);
    }
  }
  for (const t of text.matchAll(/transition(?:-property)?\s*:\s*([^;}]+)/g)) {
    for (const part of (t[1] ?? "").split(",")) {
      const prop = part.trim().split(/\s+/)[0] ?? "";
      if (prop === "all" || LAYOUT_PROPS.has(prop)) found.add(prop);
    }
  }
  return [...found];
}

const READS_LAYOUT =
  /\.(?:offsetWidth|offsetHeight|offsetTop|offsetLeft|clientWidth|clientHeight|scrollTop|scrollHeight|scrollWidth)\b|getBoundingClientRect\s*\(|getComputedStyle\s*\(/;
const WRITES_STYLE =
  /\.style\.\w+\s*=[^=]|\.style\.cssText\s*=|\.style\.setProperty\s*\(|\.setAttribute\(\s*["']style["']/;
const WINDOW = 500;

/**
 * How many of the texts have an animation loop that reads a layout value and writes a style close to the same
 * `requestAnimationFrame`: every frame then makes the browser lay the page out twice. A window around each call
 * is searched, so the cost is linear in the text however long a minified line is.
 */
export function layoutThrashLoops(texts: readonly string[]): number {
  let n = 0;
  for (const text of texts) {
    const code = text.slice(0, 2_000_000);
    let from = 0;
    for (
      let at = code.indexOf("requestAnimationFrame", from);
      at !== -1;
      at = code.indexOf("requestAnimationFrame", from)
    ) {
      const window = code.slice(Math.max(0, at - WINDOW), at + WINDOW);
      if (READS_LAYOUT.test(window) && WRITES_STYLE.test(window)) {
        n += 1;
        break;
      }
      from = at + 1;
    }
  }
  return n;
}
