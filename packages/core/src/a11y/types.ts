/**
 * What the renderer hands back when a check asks for the page's accessibility facts (N16): numbers and short
 * strings the browser computed, never a live page. Everything in it was written by the site, so it is data (rule
 * 11): `readA11y` cuts it to these shapes and bounds before anything reads it.
 */

/** A colour as the browser computed it: red, green, blue (0 to 255) and alpha (0 to 1). */
export type Rgba = readonly [number, number, number, number];

/** One element that shows text, with the colours the browser resolved for it. */
export interface TextSample {
  tag: string;
  /** The first words of the element's own text, cleaned and cut. */
  text: string;
  fg: Rgba;
  /** The colour behind the text, opaque, or null when it sits on an image or gradient the browser cannot reduce to one colour. */
  bg: readonly [number, number, number] | null;
  /** Font size in CSS pixels. */
  px: number;
  bold: boolean;
}

/** One thing the keyboard can reach, in the order Tab visits it. */
export interface Focusable {
  tag: string;
  role: string;
  /** The accessible name as far as the browser's attributes and text give one: "" when there is none. */
  name: string;
  /** The tabindex attribute as written, or null. */
  tabindex: number | null;
  x: number;
  y: number;
}

/** An element with a widget role that the keyboard cannot reach. */
export interface UnreachableWidget {
  tag: string;
  role: string;
  name: string;
}

export interface Landmark {
  /** main, navigation, banner, contentinfo, complementary, search, region or form. */
  role: string;
  name: string;
}

export interface MotionRead {
  /** Animations running or paused on the page when it was read (CSS animations, transitions and the Web Animations API). */
  animations: number;
  /** How many of those never end. */
  endless: number;
  /** A `prefers-reduced-motion` rule was found in a stylesheet the page's own origin serves. */
  reducedMotionRule: boolean;
  /** Stylesheets the browser would not let the script read (another origin), so a rule in them is not seen. */
  unreadableSheets: number;
}

export interface A11yRead {
  text: TextSample[];
  /** Text elements past the cap, not sampled. */
  textOmitted: number;
  focusables: Focusable[];
  unreachable: UnreachableWidget[];
  landmarks: Landmark[];
  motion: MotionRead;
}
