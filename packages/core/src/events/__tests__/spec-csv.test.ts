import { describe, expect, it } from "vitest";
import { ConfigError } from "../../errors.js";
import { readEventsCsv } from "../spec-csv.js";

const csv = (...lines: string[]) => lines.join("\n");

describe("readEventsCsv: the spreadsheet a tracking spec usually is", () => {
  it("reads a region or a selector, the event and its parameters, one plan line per row", () => {
    const c = readEventsCsv(
      csv(
        "Region,Selector,Event,Parameters",
        'nav,,menu_click,"link_text, link_url; menu_parent"',
        ",button.book,book_click,button_text",
      ),
      "spec.csv",
    );
    expect(c.events).toEqual([
      { region: "nav", event: "menu_click", params: ["link_text", "link_url", "menu_parent"] },
      { selector: "button.book", event: "book_click", params: ["button_text"] },
    ]);
    expect(c.attributes).toEqual([]);
  });

  it("matches the headers loosely, like the launch plan reader: case, punctuation, a few names", () => {
    const c = readEventsCsv(
      csv("Element,EVENT_NAME,Required Params", "footer,footer_click,link_text"),
      "spec.csv",
    );
    expect(c.events).toEqual([{ region: "footer", event: "footer_click", params: ["link_text"] }]);
    const d = readEventsCsv(csv("CSS selector,Event name", "a.cta,cta_click"), "spec.csv");
    expect(d.events).toEqual([{ selector: "a.cta", event: "cta_click", params: [] }]);
  });

  it("an Element cell that is a region name is a region; anything else is a selector", () => {
    const c = readEventsCsv(csv("Element,Event", "Nav,a_click", "#cart a,b_click"), "spec.csv");
    expect(c.events.map((e) => ("region" in e ? e.region : e.selector))).toEqual([
      "nav",
      "#cart a",
    ]);
  });

  it("a row can also require attributes, with or without an event", () => {
    const c = readEventsCsv(
      csv(
        "Region,Event,Parameters,Attributes",
        "nav,menu_click,link_text,data-track; data-parent",
        "footer,,,data-track",
      ),
      "spec.csv",
    );
    expect(c.events).toHaveLength(1);
    expect(c.attributes).toEqual([
      { region: "nav", require: ["data-track", "data-parent"] },
      { region: "footer", require: ["data-track"] },
    ]);
  });

  it("quoted cells hold commas, quotes and line breaks; blank rows and a BOM are ignored", () => {
    const c = readEventsCsv(
      `\uFEFFRegion,Event,Parameters\r\n\r\nnav,"menu ""main"" click","a,\nb"\r\n`,
      "spec.csv",
    );
    expect(c.events).toEqual([{ region: "nav", event: 'menu "main" click', params: ["a", "b"] }]);
  });

  it("cells are data: a formula or markup in a cell is kept as text and never run", () => {
    const c = readEventsCsv(csv("Selector,Event", "a.x,=HYPERLINK(1)"), "spec.csv");
    expect(c.events[0]?.event).toBe("=HYPERLINK(1)");
  });
});

describe("readEventsCsv: what it refuses, with the line", () => {
  const fails = (text: string) => {
    try {
      readEventsCsv(text, "spec.csv");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      return (err as ConfigError).message;
    }
    throw new Error("did not throw");
  };

  it("an empty file, or one with no element and event column, says what columns it needs", () => {
    expect(fails("")).toBe("spec.csv is empty: it needs a header row and one row per element.");
    expect(fails("Name,Colour\na,b")).toBe(
      'spec.csv: no column names the elements or the event. Use a "Region" or "Selector" column and an "Event" column.',
    );
  });

  it("a row with both a region and a selector, or neither, names its line", () => {
    expect(fails(csv("Region,Selector,Event", "nav,a.x,e"))).toBe(
      "spec.csv line 2: give a selector or a region, not both.",
    );
    expect(fails(csv("Region,Selector,Event", ",,e"))).toBe(
      "spec.csv line 2: give a selector or a region, not both.",
    );
  });

  it("an unknown region, a row with no event and no attributes, and a bad attribute name name their line", () => {
    expect(fails(csv("Region,Event", "sidebar,e"))).toBe(
      'spec.csv line 2: the region "sidebar" is not one of nav, header, footer, main. Put a CSS selector in a Selector column instead.',
    );
    expect(fails(csv("Region,Event,Attributes", "nav,,"))).toBe(
      "spec.csv line 2: give an event, attributes, or both.",
    );
    expect(fails(csv("Region,Event,Attributes", "nav,,bad name"))).toContain("spec.csv line 2:");
  });

  it("line numbers follow the file, counting a quoted line break", () => {
    expect(fails(csv("Region,Event,Parameters", 'nav,e,"a', 'b"', "sidebar,e,"))).toContain(
      "spec.csv line 4:",
    );
  });

  it("a file with a header and no rows is refused, not read as an empty plan", () => {
    expect(fails("Region,Event")).toBe("spec.csv has a header row and no rows.");
  });
});

describe("the nav-events roastery's plan, as a CSV and as JSON", () => {
  it("both files read to the same plan", async () => {
    const { readFileSync } = await import("node:fs");
    const { SITES_DIR } = await import("../../../../fixtures/src/index.js");
    const { eventsConfigSchema } = await import("../types.js");
    const json = eventsConfigSchema.parse(
      JSON.parse(readFileSync(`${SITES_DIR}nav-events/gaugeline.events.json`, "utf8")),
    );
    const csvText = readFileSync(`${SITES_DIR}nav-events-csv/gaugeline.events.csv`, "utf8");
    const fromCsv = readEventsCsv(csvText, "gaugeline.events.csv");
    expect(fromCsv.events[0]).toEqual(json.events[0]);
    expect(fromCsv.events[1]).toEqual({
      selector: "button.book",
      event: "book_click",
      params: ["button_text"],
    });
  });
});
