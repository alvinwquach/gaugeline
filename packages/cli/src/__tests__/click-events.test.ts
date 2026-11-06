import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  eventsConfigSchema,
  type ClickTarget,
  type EventsRead,
  type ObserveResult,
} from "@gaugeline/core";
import { SITES_DIR, expectedOutput, startFixture } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { EVENTS_CSV_COLUMNS, csvCell, eventsCsv } from "../events-export.js";
import { main } from "../main.js";

const withoutPassed = (text: string) => text.replace(/^✓ [a-z0-9-]+\n/gm, "");

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

describe("click events: CSV export (unit)", () => {
  it("quotes commas, quotes and newlines, and defuses spreadsheet formulas", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('say "hi", twice')).toBe('"say ""hi"", twice"');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("-1")).toBe("'-1");
  });

  it("one row per element clicked, from the fixture's recorded observation", () => {
    const dir = `${SITES_DIR}nav-events/`;
    const config = eventsConfigSchema.parse(
      JSON.parse(readFileSync(`${dir}gaugeline.events.json`, "utf8")),
    );
    const result = JSON.parse(readFileSync(`${dir}observations.json`, "utf8")) as ObserveResult;
    const target = (
      path: string,
      text: string,
      destination: string,
      parent?: string,
    ): ClickTarget => ({
      path,
      rule: 0,
      text,
      destination,
      ...(parent ? { parent } : {}),
      newTab: false,
    });
    const read: EventsRead = {
      config,
      result,
      targets: [
        target(
          "#menu > ul > li:nth-of-type(1) > ul > li:nth-of-type(1) > a",
          "Coffee",
          "https://roast.example/coffee",
          "Shop",
        ),
        target(
          "#menu > ul > li:nth-of-type(2) > ul > li:nth-of-type(2) > a",
          "Hours",
          "https://roast.example/hours",
          "Visit",
        ),
      ],
    };
    expect(eventsCsv(read).split("\r\n")).toEqual([
      EVENTS_CSV_COLUMNS.join(","),
      '#menu > ul > li:nth-of-type(1) > ul > li:nth-of-type(1) > a,Coffee,https://roast.example/coffee,Shop,menu_click,ok,"{""event"":""menu_click"",""link_text"":""Coffee"",""link_url"":""/coffee"",""menu_parent"":""Shop""}"',
      "#menu > ul > li:nth-of-type(2) > ul > li:nth-of-type(2) > a,Hours,https://roast.example/hours,Visit,menu_click,silent,",
      "",
    ]);
  });
});

describe("click events: e2e (CLI, version 0.1.0)", () => {
  it("with gaugeline.events.json and no rendered read, both checks are listed as could not check", async () => {
    const site = await startFixture("nav-events");
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const run = capture();
      const code = await main([site.origin, "--no-open", "--allow-private"], run.io, {
        version: "0.1.0",
        cwd: `${SITES_DIR}nav-events`,
      });
      if (process.env.PRINT_EVENTS_OUTPUT) console.log(withoutPassed(run.out()));
      expect(code).toBe(0);
      expect(withoutPassed(run.out()).trimEnd()).toBe(
        expectedOutput("guides/click-events", "Example"),
      );
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
      await site.close();
    }
  });

  it("an invalid gaugeline.events.json stops the run naming the field (exit 2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-events-"));
    try {
      writeFileSync(
        join(dir, "gaugeline.events.json"),
        JSON.stringify({ events: [{ selector: "nav a", region: "nav", event: "menu_click" }] }),
      );
      const run = capture();
      expect(await main(["https://pop.example/"], run.io, { cwd: dir })).toBe(2);
      expect(run.err()).toContain(
        "gaugeline.events.json: events.0: give a selector or a region, not both.",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
