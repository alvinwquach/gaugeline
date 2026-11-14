import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import {
  BUILTIN_TYPES,
  objectsAround,
  schemaTypes,
  sectionTypes,
  viewsOf,
  type View,
} from "./content-source.js";
import { lineOf, notReadReason, sortFindings } from "./scan.js";

/**
 * FF-27: a page-builder section the schema lets editors add that the page renderer has no component
 * for (the section silently renders nothing), or a component the renderer registers that no schema type
 * matches (dead code). The check reads the schema's section arrays (an `of: [{ type: "hero" }, ...]` in a
 * field named sections, blocks, pageBuilder, content or modules), and the renderer: the files outside the
 * schema that mention `_type`. A section name counts as handled when it appears as a quoted name in a
 * renderer file (a `case`, a comparison, a quoted map key) or as an unquoted map key. A renderer map is an object with two or more
 * `name: Component` entries; a key of one that no schema `name` matches is a component with no schema.
 *
 * Not sure is not a pass: no section array in the schema, or no renderer file (nothing mentions `_type`)
 * is could-not-check.
 *
 * // [GC] no source found (uncited): how a page builder maps `_type` to a component is a pattern, not a documented framework behaviour.
 */
const ID = "section-type-component-mismatch";

const SCHEMA_FILE = /\bdefine(?:Type|Field)\s*\(/;
const ENTRY = /(?<![\w$.])(["']?)([A-Za-z][\w-]*)\1\s*:\s*(?:[A-Z]\w*\b|dynamic\s*\(|lazy\s*\()/g;

export const sectionTypeComponentMismatch = defineCheck<LocalSourceInput>({
  id: ID,
  size: "S",
  done: "Every section type an editor can add has a component, and every component has a section type.",
  estimateChanges:
    "Adding a missing component is the real work, and depends on its design. Deleting a dead one is minutes.",
  area: "Launch day",
  severity: "medium",
  title: "A page section and its component do not match",
  what: "A section the schema lets editors add has no component in the page renderer, or the renderer has a component that no schema section matches.",
  why: "A section with no component renders nothing: an editor adds a gallery to the page, publishes, and the page looks the same. A component with no schema is code nobody can reach, and it tends to be copied around until someone changes the wrong one.",
  fix: "For each section the schema lists, add its component to the renderer's map (or its case). For a component with no section, either add the section to the schema's list or delete the component.",
  tech: "reads the folder's code files (.env files never); the type names listed as members of an array field named sections, blocks, pageBuilder, content or modules in the files that define a schema, against the renderer: the files outside the schema that mention _type; a section name that appears quoted in no renderer file is a finding (the schema file and line); a renderer object with two or more name: Component entries, one of whose keys matches no name in the schema, is a finding (the renderer file and line); no section array in the schema, or no renderer file, is could-not-check",
  run(input, ctx) {
    const { tree } = input;
    const url = `source:${tree.label}`;
    const views = viewsOf(input);
    const schema = schemaTypes(views);
    const sections = sectionTypes(schema.types);
    const renderers = views.filter((v) => !SCHEMA_FILE.test(v.code) && /\b_type\b/.test(v.code));
    const names = new Set<string>();
    for (const t of schema.types) if (t.name !== undefined) names.add(t.name);
    for (const s of sections) names.add(s.name);
    const findings: Finding[] = [];
    if (renderers.length > 0) {
      for (const s of sections) {
        const re = new RegExp(`["'\`]${s.name}["'\`]|(?<![\\w$.])${s.name}\\s*:\\s*[A-Z]`);
        if (renderers.some((v) => re.test(v.code))) continue;
        findings.push({
          checkId: ID,
          severity: "medium",
          title: this.title,
          evidence: `${s.file}: the section type "${s.name}" has no component in the renderer, so it renders nothing.`,
          url,
          source: { file: s.file, line: lineOf(s.view.code, s.index) },
        });
      }
      for (const v of renderers) findings.push(...deadComponents(v, names, url, this.title));
    }
    sortFindings(findings);
    if (findings.length === 0) {
      const why =
        notReadReason(tree) ??
        (sections.length === 0
          ? "no array of section types (sections, blocks, pageBuilder) was found in a Sanity schema in the folder"
          : renderers.length === 0
            ? "no page renderer was found: no file outside the schema mentions _type"
            : undefined);
      if (why !== undefined) ctx.couldNotCheck?.(url, why);
    }
    return findings;
  },
});

/** The keys of a renderer map (an object of two or more `name: Component` entries) that no schema name matches. */
function deadComponents(
  view: View,
  names: ReadonlySet<string>,
  url: string,
  title: string,
): Finding[] {
  const byObject = new Map<number, { key: string; index: number }[]>();
  for (const m of view.code.matchAll(ENTRY)) {
    const live =
      m[1] === "" ? view.bare[m.index] === view.code[m.index] : view.bare[m.index] === m[1];
    const obj = objectsAround(view.bare, m.index)[0];
    if (!live || obj === undefined) continue;
    const list = byObject.get(obj.start) ?? [];
    list.push({ key: m[2] ?? "", index: m.index });
    byObject.set(obj.start, list);
  }
  const out: Finding[] = [];
  for (const entries of byObject.values()) {
    if (entries.length < 2) continue;
    for (const e of entries) {
      if (names.has(e.key) || BUILTIN_TYPES.has(e.key)) continue;
      out.push({
        checkId: ID,
        severity: "medium",
        title,
        evidence: `${view.file}: the renderer has a component for "${e.key}", and no schema type has that name.`,
        url,
        source: { file: view.file, line: lineOf(view.code, e.index) },
      });
    }
  }
  return out;
}
