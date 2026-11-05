import type { FlatSchema } from "../../schema-rules.js";

export interface Crumb {
  position: number;
  name?: string;
  url?: string;
}

/** The first BreadcrumbList's items, sorted by position. item may be a URL or {"@id", "name"}. */
export function breadcrumbItems(flat: FlatSchema): Crumb[] | undefined {
  const list = [...flat.byId.values(), ...flat.unnamed].find((n) =>
    n.types.includes("BreadcrumbList"),
  );
  if (!list) return undefined;
  const raw = list.value.itemListElement;
  const items = (Array.isArray(raw) ? raw : [raw]).filter(
    (x): x is Record<string, unknown> => x !== null && typeof x === "object",
  );
  return items
    .map((it, i) => {
      const item = it.item;
      const url =
        typeof item === "string"
          ? item
          : item && typeof item === "object"
            ? ((item as Record<string, unknown>)["@id"] as string | undefined)
            : undefined;
      const name =
        typeof it.name === "string"
          ? it.name
          : item &&
              typeof item === "object" &&
              typeof (item as Record<string, unknown>).name === "string"
            ? ((item as Record<string, unknown>).name as string)
            : undefined;
      return {
        position: Number(it.position ?? i + 1),
        ...(name ? { name } : {}),
        ...(url ? { url } : {}),
      };
    })
    .sort((a, b) => a.position - b.position);
}
