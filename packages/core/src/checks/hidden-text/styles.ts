/** Inline-style rules for text a visitor cannot see. No stylesheet is read and nothing is rendered. */

const NAMED: Record<string, string> = {
  black: "#000000",
  silver: "#c0c0c0",
  gray: "#808080",
  grey: "#808080",
  white: "#ffffff",
  maroon: "#800000",
  red: "#ff0000",
  purple: "#800080",
  fuchsia: "#ff00ff",
  green: "#008000",
  lime: "#00ff00",
  olive: "#808000",
  yellow: "#ffff00",
  navy: "#000080",
  blue: "#0000ff",
  teal: "#008080",
  aqua: "#00ffff",
};

const COLOUR = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|[a-z]+/g;

/** The first colour in a CSS value as #rrggbb (alpha ignored), or undefined. */
export function colour(value: string): string | undefined {
  for (const raw of value.toLowerCase().match(COLOUR) ?? []) {
    if (raw.startsWith("#")) {
      const hex = raw.slice(1);
      if (hex.length === 3 || hex.length === 4)
        return `#${[...hex.slice(0, 3)].map((c) => c + c).join("")}`;
      if (hex.length === 6 || hex.length === 8) return `#${hex.slice(0, 6)}`;
      continue;
    }
    if (raw.startsWith("rgb")) {
      const parts = (raw.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      if (parts.length < 3 || parts.some((n) => !Number.isFinite(n) || n > 255)) continue;
      return `#${parts.map((n) => Math.round(n).toString(16).padStart(2, "0")).join("")}`;
    }
    const named = NAMED[raw];
    if (named) return named;
  }
  return undefined;
}

function declarations(style: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of style.split(";")) {
    const at = part.indexOf(":");
    if (at < 0) continue;
    const prop = part.slice(0, at).trim().toLowerCase();
    const value = part
      .slice(at + 1)
      .replace(/!\s*important/i, "")
      .trim()
      .toLowerCase();
    if (prop !== "") out.set(prop, value);
  }
  return out;
}

/** The number in a CSS length such as "-9999px" or "0.5em", or undefined. */
function amount(value: string | undefined): number | undefined {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))[a-z%]*$/.exec(value ?? "");
  return m ? Number(m[1]) : undefined;
}

/** A position this far left of or above the page is off the screen. */
const OFF_SCREEN = -1000;

/**
 * How an element hides its own text, or undefined if it does not: the hidden attribute,
 * aria-hidden="true", or an inline style (display:none, visibility:hidden, font-size:0, opacity:0,
 * left or top at -1000 or further, text the colour of its own background). The first that applies.
 */
export function hiddenReason(attribs: Record<string, string>): string | undefined {
  if (attribs["hidden"] !== undefined) return "hidden attribute";
  if ((attribs["aria-hidden"] ?? "").trim().toLowerCase() === "true") return "aria-hidden";
  const style = attribs["style"];
  if (!style) return undefined;
  const d = declarations(style);
  if (d.get("display") === "none") return "display:none";
  const visibility = d.get("visibility");
  if (visibility === "hidden" || visibility === "collapse") return "visibility:hidden";
  if (amount(d.get("font-size")) === 0) return "font-size:0";
  if (amount(d.get("opacity")) === 0) return "opacity:0";
  for (const side of ["left", "top"] as const) {
    const n = amount(d.get(side));
    if (n !== undefined && n <= OFF_SCREEN) return `off-screen position (${side}:${d.get(side)})`;
  }
  const text = colour(d.get("color") ?? "");
  const background = colour(d.get("background-color") ?? d.get("background") ?? "");
  if (text !== undefined && text === background) return "same colour as its background";
  return undefined;
}
