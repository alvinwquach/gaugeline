import { ConfigError } from "../errors.js";
import { normaliseHeader, parseCsv } from "../plan/columns.js";
import {
  REGIONS,
  attributeRuleSchema,
  eventRuleSchema,
  eventsConfigSchema,
  type AttributeRule,
  type EventRule,
  type EventsConfig,
} from "./types.js";

/** Normalised header -> column. A header either maps or it doesn't; the docs list these names. */
const COLUMNS = {
  region: "region",
  selector: "selector",
  "css selector": "selector",
  element: "element",
  elements: "element",
  target: "element",
  event: "event",
  "event name": "event",
  parameters: "params",
  parameter: "params",
  params: "params",
  "required parameters": "params",
  "required params": "params",
  attributes: "attributes",
  attribute: "attributes",
  "required attributes": "attributes",
} as const;
type Column = (typeof COLUMNS)[keyof typeof COLUMNS];

const isRegion = (v: string): v is (typeof REGIONS)[number] =>
  (REGIONS as readonly string[]).includes(v);

/** A cell that holds several names: commas, semicolons or line breaks between them. */
const names = (cell: string): string[] =>
  cell
    .split(/[,;\r\n]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");

/**
 * The tracking spec as a spreadsheet export: one row per plan line, read like the launch plan reader
 * reads its CSV (RFC 4180, headers matched loosely, a BOM and blank rows ignored). A row names its
 * elements in a Region column (nav, header, footer, main), a Selector column (CSS), or an Element column
 * that holds either; an Event column and a Parameters column make an events line, and an Attributes column
 * an attributes line (a row may have both). Cells are data: nothing in one is run, and a formula stays text.
 * Returns the same shape gaugeline.events.json parses to. A row that cannot be read stops the run, naming
 * its line.
 */
export function readEventsCsv(text: string, file: string): EventsConfig {
  const records = parseCsv(text.replace(/^\uFEFF/, "")).filter((r) =>
    r.cells.some((c) => c.trim() !== ""),
  );
  const [header, ...rows] = records;
  if (!header)
    throw new ConfigError(`${file} is empty: it needs a header row and one row per element.`);
  const at = new Map<Column, number>();
  header.cells.forEach((h, i) => {
    const column = (COLUMNS as Record<string, Column | undefined>)[normaliseHeader(h)];
    if (column && !at.has(column)) at.set(column, i);
  });
  const hasElement = at.has("region") || at.has("selector") || at.has("element");
  if (!hasElement || (!at.has("event") && !at.has("attributes")))
    throw new ConfigError(
      `${file}: no column names the elements or the event. Use a "Region" or "Selector" column and an "Event" column.`,
      { hint: "A header row such as: Region,Selector,Event,Parameters" },
    );
  if (rows.length === 0) throw new ConfigError(`${file} has a header row and no rows.`);
  const cell = (cells: readonly string[], c: Column) => (cells[at.get(c) ?? -1] ?? "").trim();
  const events: EventRule[] = [];
  const attributes: AttributeRule[] = [];
  for (const { line, cells } of rows) {
    const fail = (message: string): never => {
      throw new ConfigError(`${file} line ${line}: ${message}`);
    };
    const region = cell(cells, "region").toLowerCase();
    const selector = cell(cells, "selector");
    const element = cell(cells, "element");
    const targets: ({ region: (typeof REGIONS)[number] } | { selector: string })[] = [];
    if (region !== "") {
      if (!isRegion(region))
        fail(
          `the region "${cell(cells, "region")}" is not one of ${REGIONS.join(", ")}. Put a CSS selector in a Selector column instead.`,
        );
      else targets.push({ region });
    }
    if (selector !== "") targets.push({ selector });
    if (element !== "")
      targets.push(
        isRegion(element.toLowerCase())
          ? { region: element.toLowerCase() as never }
          : { selector: element },
      );
    if (targets.length !== 1) fail("give a selector or a region, not both.");
    const target = targets[0] as { region: (typeof REGIONS)[number] } | { selector: string };
    const event = cell(cells, "event");
    const required = names(cell(cells, "attributes"));
    if (event === "" && required.length === 0) fail("give an event, attributes, or both.");
    if (event !== "") {
      const parsed = eventRuleSchema.safeParse({
        ...target,
        event,
        params: names(cell(cells, "params")),
      });
      if (!parsed.success) fail(`${parsed.error.issues[0]?.message ?? "not valid"}.`);
      else events.push(parsed.data);
    }
    if (required.length > 0) {
      const parsed = attributeRuleSchema.safeParse({ ...target, require: required });
      if (!parsed.success) fail(`${parsed.error.issues[0]?.message ?? "not valid"}.`);
      else attributes.push(parsed.data);
    }
  }
  return eventsConfigSchema.parse({ events, attributes });
}
