import { CheckRegistry, defineCheck, type Check } from "../model.js";
import { GENERATED_TITLES } from "../query/generated.js";
import { queryTypeEmpty, type QueryInput } from "./query-counts.js";

const only = (id: string, input: QueryInput) =>
  (input.generated ?? []).filter((f) => f.checkId === id);

const TECH =
  "one GET of the query endpoint for each rule (perspective=published, so drafts are never read); the filter does the comparing, so only ids and whole numbers come back, never a stated number, a part or any other field: the type's document count, the _id of the documents that have no stated number, and the _id of those where stated != coalesce(math::sum(parts), 0); a part that does not dereference is null and math::sum skips it; exact equality on the numbers, and the stated field or a part that is not a number on some document is exit 2 and nothing is reported";

export const generatedTotalMismatch = defineCheck<QueryInput>({
  id: "generated-total-mismatch",
  size: "M",
  done: "Each stated total equals the sum of its parts.",
  estimateChanges:
    "Deciding which side is wrong comes first. A part missing because something it links to is unpublished adds another fix.",
  area: "Visitors",
  severity: "high",
  title: GENERATED_TITLES.mismatch,
  what: "A document states a number, a total, and the parts it is made of add up to a different one.",
  why: "Content written by a pipeline or a model states a total next to its parts and does not check its own sums. The page then promises a number the parts cannot deliver (a meal plan that says 2,400 calories and contains 1,830), and the customer notices before you do.",
  fix: "Open the document by its id in the Studio and decide which side is wrong: the stated number or a part. If a part is missing because something it links to is not published, the references finding for the same document says which. Fix the pipeline's arithmetic if it keeps happening.",
  tech: `${TECH}; stated != the sum of the parts path`,
  run: (input) => only("generated-total-mismatch", input),
});

export const generatedTotalMissing = defineCheck<QueryInput>({
  id: "generated-total-missing",
  size: "S",
  done: "The stated field is filled in on each document named, or the rule's field name is corrected.",
  estimateChanges: "Many documents are filled in one by one unless a migration sets them.",
  area: "Visitors",
  severity: "low",
  title: GENERATED_TITLES.unstated,
  what: "A document of the type has no stated total at the field the rule names, so there is nothing to compare its parts with.",
  why: "Either the pipeline skipped the field or the field was renamed. It is not a mismatch, because nothing was promised, but a page that prints the total prints a blank.",
  fix: "Open the document by its id and fill the stated field in, or check the field name in the rule against your schema.",
  tech: `${TECH}; !defined(stated)`,
  run: (input) => only("generated-total-missing", input),
});

export const generatedRefUnpublished = defineCheck<QueryInput>({
  id: "generated-ref-unpublished",
  size: "S",
  done: "Every link points at a published document, or the rule is changed on purpose.",
  estimateChanges:
    "Several documents that link to the same draft are fixed by publishing that one.",
  area: "Visitors",
  severity: "high",
  title: GENERATED_TITLES.unpublished,
  what: "A document links to other documents, and some of them are not published: they do not exist, or exist only as a draft.",
  why: "A reference to an unpublished document resolves to nothing, so a page built from it shows a gap, or a total that is short. Pipelines create the links and the documents separately and do not check that both were published.",
  fix: "Publish the documents named by their ids, or remove the links to them. If the links are meant to be weak, this is expected and the rule is the wrong one.",
  tech: "one GET of the query endpoint for each rule (perspective=published, so a draft target counts as missing); for each document of the type, the references at the path are counted, and so are those where defined(@->_id); a document where the two differ comes back as its _id, both counts and the _ref of the missing targets (ids), ten at most; nothing else of the document is projected; an item that has no _ref is not a reference and is not counted",
  run: (input) => only("generated-ref-unpublished", input),
});

/** The checks `gaugeline query --totals` and `--refs` add. They read the findings in a QueryInput. */
export const QUERY_GENERATED_CHECKS: readonly Check<QueryInput>[] = [
  generatedTotalMismatch,
  generatedTotalMissing,
  generatedRefUnpublished,
];

/** `--totals` and `--refs` are their own run: the three checks above, and query-type-empty for a type with no documents. */
export function createGeneratedRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  registry.register(queryTypeEmpty);
  for (const c of QUERY_GENERATED_CHECKS) registry.register(c);
  return registry;
}
