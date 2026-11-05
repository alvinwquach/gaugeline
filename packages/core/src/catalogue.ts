import { SEVERITY_ORDER, type Area, type CheckRegistry, type Severity } from "./model.js";

/** One check as the checks reference shows it. Plain data: it serialises to JSON unchanged. */
export interface CatalogueEntry {
  id: string;
  severity: Severity;
  area: Area;
  title: string;
  what: string;
  why: string;
  fix: string;
  tech: string;
}

/**
 * Every registered check, high before medium before low, registration order within a level.
 * Two checks with the same title are refused: titles are what people search for.
 */
export function catalogue(registry: CheckRegistry): CatalogueEntry[] {
  const all = registry.all();
  const titles = new Map<string, string>();
  for (const c of all) {
    const other = titles.get(c.title);
    if (other !== undefined)
      throw new Error(`Checks "${other}" and "${c.id}" have the same title: "${c.title}".`);
    titles.set(c.title, c.id);
  }
  return all
    .map((c, i) => ({ c, i }))
    .sort((a, b) => SEVERITY_ORDER[a.c.severity] - SEVERITY_ORDER[b.c.severity] || a.i - b.i)
    .map(({ c }) => ({
      id: c.id,
      severity: c.severity,
      area: c.area,
      title: c.title,
      what: c.what,
      why: c.why,
      fix: c.fix,
      tech: c.tech,
    }));
}
