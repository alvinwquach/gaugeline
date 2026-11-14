import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  findLowContrast,
  focusJumps,
  landmarkProblems,
  motionProblem,
  unnamedControls,
} from "../analyse.js";
import type { Focusable, Landmark, MotionRead, TextSample } from "../types.js";

const text = (over: Partial<TextSample> = {}): TextSample => ({
  tag: "p",
  text: "Fresh bread",
  fg: [0, 0, 0, 1],
  bg: [255, 255, 255],
  px: 16,
  bold: false,
  ...over,
});
const focus = (over: Partial<Focusable> = {}): Focusable => ({
  tag: "a",
  role: "link",
  name: "Home",
  tabindex: null,
  x: 0,
  y: 0,
  ...over,
});

describe("contrastRatio: WCAG 2 relative luminance", () => {
  it("is 21 for black on white and 1 for the same colour", () => {
    expect(contrastRatio([0, 0, 0, 1], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrastRatio([255, 255, 255, 1], [255, 255, 255])).toBeCloseTo(1, 5);
  });
  it("matches the published ratio for #767676 on white (4.54) and #777777 on white (4.48)", () => {
    expect(contrastRatio([0x76, 0x76, 0x76, 1], [255, 255, 255])).toBeCloseTo(4.54, 2);
    expect(contrastRatio([0x77, 0x77, 0x77, 1], [255, 255, 255])).toBeCloseTo(4.48, 2);
  });
  it("is the same whichever of the two is lighter", () => {
    expect(contrastRatio([10, 90, 200, 1], [250, 250, 20])).toBeCloseTo(
      contrastRatio([250, 250, 20, 1], [10, 90, 200]),
      10,
    );
  });
  it("lays a translucent text colour over the background first", () => {
    // Black at 50% over white is mid grey (#808080-ish): about 3.95, not 21.
    const r = contrastRatio([0, 0, 0, 0.5], [255, 255, 255]);
    expect(r).toBeGreaterThan(3.9);
    expect(r).toBeLessThan(4.1);
  });
});

describe("findLowContrast", () => {
  it("passes text of 4.5 and fails 4.49 at normal size", () => {
    const ok = findLowContrast([text({ fg: [0x76, 0x76, 0x76, 1] })]);
    expect(ok.low).toEqual([]);
    const bad = findLowContrast([text({ fg: [0x77, 0x77, 0x77, 1] })]);
    expect(bad.low.map((l) => [l.ratioHundredths, l.required])).toEqual([[447, 4.5]]);
  });
  it("asks 3 for large text: 24 px, or 18.66 px and bold", () => {
    const grey = [0x94, 0x94, 0x94, 1] as const; // about 3.03
    expect(findLowContrast([text({ fg: grey, px: 24 })]).low).toEqual([]);
    expect(findLowContrast([text({ fg: grey, px: 19, bold: true })]).low).toEqual([]);
    expect(findLowContrast([text({ fg: grey, px: 19, bold: false })]).low).toHaveLength(1);
    expect(findLowContrast([text({ fg: grey, px: 18, bold: true })]).low).toHaveLength(1);
  });
  it("groups elements with the same colours and size, worst first, and keeps a few examples", () => {
    const a = text({ fg: [200, 200, 200, 1], text: "One" });
    const b = text({ fg: [200, 200, 200, 1], text: "Two" });
    const c = text({ fg: [230, 230, 230, 1], text: "Three" });
    const out = findLowContrast([a, b, c]);
    expect(out.low.map((l) => [l.count, l.examples])).toEqual([
      [1, ["Three"]],
      [2, ["One", "Two"]],
    ]);
  });
  it("counts text on an image or gradient as not computed, never as a pass or a failure", () => {
    const out = findLowContrast([text({ bg: null }), text({ bg: null }), text()]);
    expect(out.low).toEqual([]);
    expect(out.unknown).toBe(2);
  });
  it("skips text with no size", () => {
    expect(findLowContrast([text({ px: 0 })]).low).toEqual([]);
  });
});

describe("focusJumps and positive tabindex", () => {
  it("is quiet for an order that goes down the page and across", () => {
    const f = [focus({ y: 0 }), focus({ y: 0, x: 100 }), focus({ y: 200 }), focus({ y: 400 })];
    expect(focusJumps(f)).toEqual({ positive: [], jumps: [] });
  });
  it("names every element with a positive tabindex", () => {
    const f = [
      focus({ tabindex: 2, name: "Order" }),
      focus({ tabindex: 0 }),
      focus({ tabindex: 1, name: "Menu" }),
    ];
    expect(focusJumps(f).positive.map((p) => p.name)).toEqual(["Order", "Menu"]);
  });
  it("counts a move back up the page of more than 40 pixels, and names where from and to", () => {
    const f = [
      focus({ y: 100, name: "A" }),
      focus({ y: 600, name: "B" }),
      focus({ y: 50, name: "C" }),
      focus({ y: 700, name: "D" }),
      focus({ y: 100, name: "E" }),
    ];
    expect(focusJumps(f).jumps.map((j) => [j.from, j.to])).toEqual([
      ["B", "C"],
      ["D", "E"],
    ]);
  });
  it("does not count a move of 40 pixels or less", () => {
    expect(focusJumps([focus({ y: 100 }), focus({ y: 60 })]).jumps).toEqual([]);
  });
});

describe("unnamedControls", () => {
  it("lists controls with no accessible name, and leaves named ones and links to nothing alone", () => {
    const f = [
      focus({ tag: "button", role: "button", name: "" }),
      focus({ tag: "a", role: "link", name: "   " }),
      focus({ tag: "input", role: "textbox", name: "" }),
      focus({ tag: "button", role: "button", name: "Buy" }),
    ];
    expect(unnamedControls(f).map((c) => c.tag)).toEqual(["button", "a", "input"]);
  });
});

describe("landmarkProblems", () => {
  const lm = (...pairs: [string, string?][]): Landmark[] =>
    pairs.map(([role, name]) => ({ role, name: name ?? "" }));
  it("is quiet for one main and nav, banner and contentinfo", () => {
    expect(landmarkProblems(lm(["banner"], ["navigation"], ["main"], ["contentinfo"]))).toEqual([]);
  });
  it("names a page with no main, and one with two", () => {
    expect(landmarkProblems(lm(["navigation"]))).toEqual([{ kind: "no-main" }]);
    expect(landmarkProblems(lm(["main"], ["main"]))).toEqual([{ kind: "many-main", count: 2 }]);
  });
  it("names two landmarks of one role with no names to tell them apart", () => {
    expect(landmarkProblems(lm(["main"], ["navigation"], ["navigation"]))).toEqual([
      { kind: "same-role", role: "navigation", count: 2 },
    ]);
    expect(
      landmarkProblems(lm(["main"], ["navigation", "Main menu"], ["navigation", "Footer menu"])),
    ).toEqual([]);
    expect(landmarkProblems(lm(["main"], ["navigation", "Menu"], ["navigation", "Menu"]))).toEqual([
      { kind: "same-role", role: "navigation", count: 2 },
    ]);
  });
});

describe("motionProblem", () => {
  const m = (over: Partial<MotionRead> = {}): MotionRead => ({
    animations: 0,
    endless: 0,
    reducedMotionRule: false,
    unreadableSheets: 0,
    ...over,
  });
  it("is nothing for a still page, and for motion with a reduced-motion rule", () => {
    expect(motionProblem(m())).toBeUndefined();
    expect(
      motionProblem(m({ animations: 3, endless: 1, reducedMotionRule: true })),
    ).toBeUndefined();
  });
  it("is a problem for motion with no rule: endless motion is the worse", () => {
    expect(motionProblem(m({ animations: 2 }))).toEqual({
      kind: "no-rule",
      animations: 2,
      endless: 0,
    });
    expect(motionProblem(m({ animations: 2, endless: 2 }))).toEqual({
      kind: "no-rule",
      animations: 2,
      endless: 2,
    });
  });
  it("is could-not-check when a stylesheet could not be read and no rule was seen", () => {
    expect(motionProblem(m({ animations: 1, unreadableSheets: 2 }))).toEqual({
      kind: "unreadable",
      sheets: 2,
    });
    expect(
      motionProblem(m({ animations: 1, unreadableSheets: 2, reducedMotionRule: true })),
    ).toBeUndefined();
  });
});
