import { describe, expect, it } from "vitest";
import {
  defineCheck as coreDefineCheck,
  type Check as CoreCheck,
  type Config as CoreConfig,
  type Finding as CoreFinding,
  type PageSnapshot as CorePage,
} from "@gaugeline/core";
import type {
  Check,
  Config,
  Finding,
  PageSnapshot,
  defineCheck as PublicDefineCheck,
} from "../lib-types.js";
import { defineCheck as entry } from "../lib.js";

// What a user of the package sees: the entry's code with the hand-written types.
const defineCheck = entry as typeof PublicDefineCheck;

/**
 * The hand-written public types must fit the engine's: what a user's check returns is a core
 * finding, what it reads is something core's page snapshot satisfies, and what it defines runs in
 * core. These lines fail the typecheck when core drifts.
 */
type Assert<T extends true> = T;
type Extends<A, B> = [A] extends [B] ? true : false;
export type FindingFits = Assert<Extends<Finding, CoreFinding>>;
export type PageFits = Assert<Extends<CorePage, PageSnapshot>>;
export type CheckFits = Assert<Extends<Check<PageSnapshot>, CoreCheck<CorePage>>>;
export type ConfigFits = Assert<Extends<Config, Partial<Pick<CoreConfig, "checks">>>>;

describe("the public entry", () => {
  it("exports the same defineCheck core has", () => {
    expect(defineCheck).toBe(coreDefineCheck);
  });

  it("builds a ten-line check", () => {
    const check = defineCheck({
      id: "hours-listed",
      area: "Visitors",
      severity: "medium",
      title: "The opening hours are not on the page",
      what: "No opening hours.",
      why: "Visitors look for them first.",
      fix: "Add them.",
      tech: "No text matching hours.",
      size: "S",
      done: "The page lists hours.",
      estimateChanges: "None.",
      run: (page) =>
        page.title
          ? []
          : [
              {
                checkId: "hours-listed",
                severity: "medium",
                title: "t",
                evidence: "e",
                url: page.finalUrl,
              },
            ],
    });
    expect(Object.isFrozen(check)).toBe(true);
  });
});
