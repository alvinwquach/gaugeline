import {
  findLowContrast,
  focusJumps,
  landmarkProblems,
  motionProblem,
  unnamedControls,
  type LowContrast,
} from "../a11y/analyse.js";
import type { A11yRead } from "../a11y/types.js";
import type { CheckContext } from "../model.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { escapeInvisible } from "./hidden-text/escape.js";

const clip = (text: string): string => escapeInvisible(text, 80);

/** What every check here asks for, so one render serves all five. */
const ASK = { a11y: true, text: false, links: false } as const;

/** What the browser computed for this page, or why nothing was: said once under the check, never a pass. */
async function facts(page: PageSnapshot, ctx: CheckContext): Promise<A11yRead | undefined> {
  const url = page.finalUrl;
  if (!ctx.render) {
    ctx.couldNotCheck?.(url, "This check reads a rendered page: run with --renderer playwright.");
    return undefined;
  }
  const r = await ctx.render({ expose: { ...ASK } });
  if (r.kind === "could-not-check") {
    ctx.couldNotCheck?.(url, `The rendered page could not be read: ${clip(r.reason)}.`);
    return undefined;
  }
  if (!r.a11y) {
    ctx.couldNotCheck?.(
      url,
      "The browser gave no accessibility facts for the page, so it was not checked.",
    );
    return undefined;
  }
  return r.a11y;
}

const hex = (c: readonly number[]): string =>
  `#${[c[0], c[1], c[2]]
    .map((n) =>
      Math.round(n ?? 0)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
const ratioText = (hundredths: number): string =>
  `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, "0")}`;

function describeGroup(g: LowContrast): string {
  const shown = g.examples.map((e) => `"${clip(e)}"`).join(", ");
  const more = g.count > g.examples.length ? ` and ${g.count - g.examples.length} more` : "";
  const who = g.examples.length === 0 ? `${g.count} elements` : `${shown}${more}`;
  return `${who} at ${ratioText(g.ratioHundredths)}:1 (needs ${g.required}:1, ${hex(g.fg)} on ${hex(g.bg)})`;
}

const GROUPS_SHOWN = 3;

export const a11yContrast = defineCheck<PageSnapshot>({
  id: "a11y-contrast",
  size: "M",
  done: "Every piece of text sampled on the rendered page has at least the WCAG contrast with what is behind it: 4.5 to 1, or 3 to 1 for large text.",
  estimateChanges:
    "Minutes per colour pair in a shared stylesheet or design token; more when the grey is set in many places or on top of photographs.",
  area: "Visitors",
  severity: "medium",
  title: "Text is too faint to read against its background",
  what: "In the rendered page, some text has less contrast with the colour behind it than WCAG 2 asks for: under 4.5 to 1, or under 3 to 1 for large text (24 px, or 18.66 px and bold).",
  why: "Faint text is hard to read for many people, in sunlight, on a cheap screen or with weaker eyesight, and it is the most common failure on the web. It also makes an accessibility complaint easy to win.",
  fix: "Darken the text or lighten the background until the pair reaches the ratio. The finding gives the ratio and both colours; a contrast checker shows the nearest colour that passes. Fix it in the shared colour setting, not text by text.",
  tech: "Only with --renderer playwright. The browser's own computed colours for up to 250 visible text elements (the text colour, and the background found by walking up through translucent layers to an opaque one, white at the top); WCAG 2 relative luminance and ratio, text colour laid over the background when translucent; 4.5 to 1 for normal text and 3 to 1 for large text. Elements are grouped by colours and size, the three worst groups are named with up to three examples, and the ratio is cut down to hundredths (4.477 is 4.47 and fails). Text on an image or gradient, and text past the 250 sampled, is could-not-check, never a pass; disabled controls and aria-hidden text are left out. The same rendered page gives the same findings",
  async run(page, ctx) {
    const a = await facts(page, ctx);
    if (!a) return [];
    const { low, unknown } = findLowContrast(a.text);
    if (unknown > 0)
      ctx.couldNotCheck?.(
        page.finalUrl,
        `${unknown} text ${unknown === 1 ? "element sits" : "elements sit"} on an image or gradient, so ${unknown === 1 ? "its" : "their"} contrast was not computed.`,
      );
    if (a.textOmitted > 0)
      ctx.couldNotCheck?.(
        page.finalUrl,
        `${a.textOmitted} more text elements were not sampled: at most 250 are.`,
      );
    if (low.length === 0) return [];
    const total = low.reduce((n, g) => n + g.count, 0);
    const rest = low.length > GROUPS_SHOWN ? ` and ${low.length - GROUPS_SHOWN} more groups` : "";
    return [
      {
        checkId: "a11y-contrast",
        severity: "medium",
        title: this.title,
        evidence: `${total} text ${total === 1 ? "element falls" : "elements fall"} short of WCAG contrast: ${low.slice(0, GROUPS_SHOWN).map(describeGroup).join("; ")}${rest}`,
        url: clip(page.finalUrl),
      },
    ];
  },
});

export const a11yFocusOrder = defineCheck<PageSnapshot>({
  id: "a11y-focus-order",
  size: "M",
  done: "No element has a positive tabindex, and keyboard focus moves down and across the page, not back up it.",
  estimateChanges:
    "Minutes to remove a positive tabindex; an hour or more when the markup order itself has to follow the visual order.",
  area: "Visitors",
  severity: "medium",
  title: "Keyboard focus does not follow the page",
  what: "In the rendered page, an element has a positive tabindex (which makes it jump the queue), or pressing Tab moves back up the page two or more times.",
  why: "People who use a keyboard or a switch move through a page with Tab, and expect it to follow what they see. A focus order that jumps around loses them, and a positive tabindex breaks the order for the whole page.",
  fix: "Remove positive tabindex values (use 0 or none) and put the markup in the order it reads. Where the screen layout differs from the document order, change the document order rather than the tabindex.",
  tech: "Only with --renderer playwright. The elements Tab reaches (links with an address, buttons, fields, summaries, iframes, editable elements and anything with a tabindex of 0 or more; disabled, hidden and tabindex -1 left out) are put in the order the browser visits them: positive tabindex first, ascending, then document order. A positive tabindex is medium. A move to a position more than 40 pixels higher than the one before counts as a jump back, and two or more are low, because one is usually a skip link or a sticky bar. Up to 300 elements are read. The same rendered page gives the same findings",
  async run(page, ctx) {
    const a = await facts(page, ctx);
    if (!a) return [];
    const { positive, jumps } = focusJumps(a.focusables);
    const parts: string[] = [];
    if (positive.length > 0)
      parts.push(
        `Positive tabindex values reorder keyboard focus: ${positive
          .slice(0, 5)
          .map((p) => `tabindex ${p.tabindex} on "${clip(p.name)}"`)
          .join(", ")}.`,
      );
    if (jumps.length >= 2)
      parts.push(
        `Keyboard focus jumps back up the page ${jumps.length} times: ${jumps
          .slice(0, 3)
          .map((j) => `from "${clip(j.from)}" to "${clip(j.to)}"`)
          .join(", ")}.`,
      );
    if (parts.length === 0) return [];
    return [
      {
        checkId: "a11y-focus-order",
        severity: positive.length > 0 ? "medium" : "low",
        title: this.title,
        evidence: parts.join(" "),
        url: clip(page.finalUrl),
      },
    ];
  },
});

export const a11yNamesRoles = defineCheck<PageSnapshot>({
  id: "a11y-names-roles",
  size: "S",
  done: "Every control the keyboard reaches has an accessible name, and every element with a widget role can be reached with the keyboard.",
  estimateChanges:
    "Minutes per control: an aria-label, a visible label or text in the button; a real button element instead of a div with a role.",
  area: "Visitors",
  severity: "medium",
  title: "A control has no name, or a widget cannot be reached",
  what: "In the rendered page, a link, button or field the keyboard reaches has no accessible name, or an element with a role such as button or link cannot be reached with the keyboard.",
  why: "A screen reader says what a control is called. A control with no name is announced as just 'button', and a div that acts as a button but cannot take focus cannot be used without a mouse at all.",
  fix: "Give each control a visible label or text, or an aria-label for an icon. Use a real button or link element, which is reachable and named by default, instead of a div with a role.",
  tech: "Only with --renderer playwright. For each element Tab reaches, the name is the aria-label, the aria-labelledby text, the label of a field, the value of a submit or button input, the text (or an image's alt or a graphic's aria-label) inside it, or its title, in that order; none is a finding. Elements with the role button, link, checkbox, switch, tab, menuitem or radio that are not natively focusable and have no tabindex of 0 or more are listed as not reachable. Up to 300 focusable and 50 unreachable elements are read. The same rendered page gives the same findings",
  async run(page, ctx) {
    const a = await facts(page, ctx);
    if (!a) return [];
    const parts: string[] = [];
    const unnamed = unnamedControls(a.focusables);
    if (unnamed.length > 0)
      parts.push(
        `${unnamed.length} ${unnamed.length === 1 ? "control the keyboard reaches has" : "controls the keyboard reaches have"} no accessible name: ${unnamed
          .slice(0, 5)
          .map((f) => `<${f.tag}>`)
          .join(", ")}.`,
      );
    if (a.unreachable.length > 0) {
      const u = a.unreachable[0];
      const named = u && u.name !== "" ? ` "${clip(u.name)}"` : "";
      parts.push(
        a.unreachable.length === 1 && u
          ? `An element with the role ${clip(u.role)} cannot be reached with the keyboard: <${u.tag}>${named}.`
          : `${a.unreachable.length} elements with a widget role cannot be reached with the keyboard: ${a.unreachable
              .slice(0, 5)
              .map((x) => `<${x.tag}> as ${clip(x.role)}`)
              .join(", ")}.`,
      );
    }
    if (parts.length === 0) return [];
    return [
      {
        checkId: "a11y-names-roles",
        severity: "medium",
        title: this.title,
        evidence: parts.join(" "),
        url: clip(page.finalUrl),
      },
    ];
  },
});

export const a11yLandmarks = defineCheck<PageSnapshot>({
  id: "a11y-landmarks",
  size: "S",
  done: "The rendered page has one main landmark, and landmarks of the same kind have names that tell them apart.",
  estimateChanges:
    "Minutes: wrap the content in a main element, add an aria-label to each repeated nav.",
  area: "Visitors",
  severity: "medium",
  title: "The page's landmarks are missing or unclear",
  what: "In the rendered page there is no main landmark, there is more than one, or several landmarks of one kind (two navs, two asides) have no names to tell them apart.",
  why: "Screen reader users jump between landmarks to skip a menu and reach the content. A page with no main has no way to jump to its content, and two unnamed navs are announced the same.",
  fix: "Put the page's content in one main element, and give each repeated nav, aside or region its own aria-label ('Main menu', 'Footer').",
  tech: "Only with --renderer playwright. Visible elements with a landmark role, by tag or role attribute: main, nav (navigation), a header and footer outside an article, aside, main, nav or section (banner, contentinfo), aside (complementary), search, form and section with a name (form, region). No main is medium. More than one main, and two or more landmarks of one role with no names or the same name, are low. Up to 50 are read. The same rendered page gives the same findings",
  async run(page, ctx) {
    const a = await facts(page, ctx);
    if (!a) return [];
    const problems = landmarkProblems(a.landmarks);
    if (problems.length === 0) return [];
    const parts = problems.map((p) =>
      p.kind === "no-main"
        ? "The page has no main landmark (a main element), so a screen reader user cannot jump to its content."
        : p.kind === "many-main"
          ? `The page has ${p.count} main landmarks; it should have one.`
          : `${p.count} ${clip(p.role)} landmarks have no names to tell them apart (give each an aria-label).`,
    );
    return [
      {
        checkId: "a11y-landmarks",
        severity: problems.some((p) => p.kind === "no-main") ? "medium" : "low",
        title: this.title,
        evidence: parts.join(" "),
        url: clip(page.finalUrl),
      },
    ];
  },
});

export const a11yReducedMotion = defineCheck<PageSnapshot>({
  id: "a11y-reduced-motion",
  size: "S",
  done: "Animation on the page is switched off or reduced for visitors who ask for it, with a prefers-reduced-motion rule in the page's own stylesheets.",
  estimateChanges:
    "Minutes: one prefers-reduced-motion media query that turns animation and transition off.",
  area: "Visitors",
  severity: "medium",
  title: "The page animates and does not honour reduced motion",
  what: "The rendered page has running animations and no prefers-reduced-motion rule in its stylesheets.",
  why: "Moving content can cause dizziness, nausea or distraction for people with vestibular or attention conditions, who set 'reduce motion' on their device and expect sites to respect it. Animation that never stops is the hardest to avoid.",
  fix: "Add a @media (prefers-reduced-motion: reduce) rule that turns off or shortens animations and transitions, and do not start motion in script for visitors who ask for less.",
  tech: "Only with --renderer playwright. The animations the browser reports on the page after it settled (CSS animations, transitions and the Web Animations API), and how many never end; and a prefers-reduced-motion media rule in any stylesheet the page's own script can read. Some animations and no rule is low, medium when one never ends. A stylesheet from another origin cannot be read, so with no rule seen and one of those present it is could-not-check, never a finding. A rule in script (matchMedia) is not seen. The same rendered page gives the same findings",
  async run(page, ctx) {
    const a = await facts(page, ctx);
    if (!a) return [];
    const p = motionProblem(a.motion);
    if (!p) return [];
    if (p.kind === "unreadable") {
      ctx.couldNotCheck?.(
        page.finalUrl,
        `${p.sheets} ${p.sheets === 1 ? "stylesheet" : "stylesheets"} from another origin could not be read, so a prefers-reduced-motion rule in ${p.sheets === 1 ? "it" : "them"} was not looked for.`,
      );
      return [];
    }
    return [
      {
        checkId: "a11y-reduced-motion",
        severity: p.endless > 0 ? "medium" : "low",
        title: this.title,
        evidence: `${p.animations} ${p.animations === 1 ? "animation runs" : "animations run"} on the page${p.endless > 0 ? ` (${p.endless} never ${p.endless === 1 ? "ends" : "end"})` : ""} and no prefers-reduced-motion rule was found in its stylesheets.`,
        url: clip(page.finalUrl),
      },
    ];
  },
});

export const A11Y_CHECKS = [
  a11yContrast,
  a11yFocusOrder,
  a11yLandmarks,
  a11yNamesRoles,
  a11yReducedMotion,
] as const;
