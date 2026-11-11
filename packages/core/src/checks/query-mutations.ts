import { CheckRegistry, defineCheck, type Check } from "../model.js";
import { MUTATION_TITLES, checkMutations } from "../query/mutations.js";
import type { QueryInput } from "./query-counts.js";

const TECH =
  "read from the repository with no request at all: the TypeScript compiler reads client.patch(...).set(...), create, createOrReplace, createIfNotExists, delete, transaction chains and raw mutations arrays into a Map from each written field to the kind of its value (a plain string, an object with _ref, anything else), which is compared with the schema file given by --schema (the output of sanity schema extract); no mutation is sent, and the module cannot import an HTTP client";

const only = (id: string, input: QueryInput) =>
  input.mutations === undefined
    ? []
    : checkMutations(input.mutations.shapes, input.mutations.schema).filter(
        (f) => f.checkId === id,
      );

export const mutationUndeclaredField = defineCheck<QueryInput>({
  id: "mutation-undeclared-field",
  size: "S",
  done: "Every field the write sets is declared by the document type.",
  estimateChanges: "Declaring a field is a schema change that also needs a deploy.",
  area: "Visitors",
  severity: "high",
  title: MUTATION_TITLES.undeclared,
  what: "A patch or create in your code writes a field that no document type in the schema declares.",
  why: "Sanity stores it anyway, so nothing fails. The Studio shows no field for it, so no editor can see or correct it, and a page that reads the field you meant never gets it. It is the usual result of a renamed field.",
  fix: "Open the file and line named. Use the name the schema declares, or declare the field in the schema if the write is right.",
  tech: `${TECH}; a written field (first path segment) that no document type declares`,
  run: (input) => only("mutation-undeclared-field", input),
});

export const mutationMissingRequired = defineCheck<QueryInput>({
  id: "mutation-missing-required",
  size: "S",
  done: "Each create sets every required field.",
  estimateChanges: "Creates in several routes are one edit each.",
  area: "Visitors",
  severity: "high",
  title: MUTATION_TITLES.missing,
  what: "A create in your code leaves out a field the schema marks as required.",
  why: "Sanity saves the document, and the Studio then shows it as invalid. A page that assumes the field is there breaks on exactly the documents your code made.",
  fix: "Add the field to the create, or stop marking it required if it is not. A create that spreads another object is not checked for this, because the spread may carry the field.",
  tech: `${TECH}; a create of a known type, with every key visible, that lacks a required field`,
  run: (input) => only("mutation-missing-required", input),
});

export const mutationRefAsString = defineCheck<QueryInput>({
  id: "mutation-ref-as-string",
  size: "S",
  done: "Each reference is written as a reference object.",
  estimateChanges: "Existing documents that already hold a string need a one-off fix.",
  area: "Visitors",
  severity: "high",
  title: MUTATION_TITLES.refAsString,
  what: "A reference field is given a plain string where an object with a _ref is needed.",
  why: "A reference is an object. A string in its place is stored without complaint, but the reference never resolves, so every query that follows it with -> gets nothing.",
  fix: 'Write { _type: "reference", _ref: "the document\'s id" } instead of the string.',
  tech: `${TECH}; a string literal written to a field the schema declares as a reference`,
  run: (input) => only("mutation-ref-as-string", input),
});

export const mutationNoDrafts = defineCheck<QueryInput>({
  id: "mutation-no-drafts",
  size: "M",
  done: "The write patches the draft and an editor publishes, or writing to the published document is recorded as intended.",
  estimateChanges:
    "Routes that write in several places each need the change, and editors need a publish step.",
  area: "Security & email",
  severity: "medium",
  title: MUTATION_TITLES.noDrafts,
  what: "A patch, createOrReplace or delete in your code has no drafts handling: its id is not a drafts. id.",
  why: "It changes the published document directly. An editor who has unpublished changes in the Studio can lose them, or have them published by the next write.",
  fix: 'Patch the draft (the id with "drafts." in front) and let an editor publish, or leave it as it is if writing straight to the published document is what you want.',
  tech: `${TECH}; an id that does not start with drafts. and is not built by something named like a draft helper`,
  run: (input) => only("mutation-no-drafts", input),
});

export const mutationSharedField = defineCheck<QueryInput>({
  id: "mutation-shared-field",
  size: "S",
  done: "One route owns the field and the others call it, or the sharing is recorded as intended.",
  estimateChanges: "Deciding which route owns it comes first.",
  area: "Visitors",
  severity: "medium",
  title: MUTATION_TITLES.shared,
  what: "Two or more routes in your code write the same field of the same document type.",
  why: "Each route assumes it owns the field. When their rules differ, the last one to run wins, and the value drifts without anyone changing it on purpose.",
  fix: "Decide which route owns the field and have the others call it, or accept it if they are meant to share it.",
  tech: `${TECH}; a Map from type.field to the routes that patch or replace it, and an entry with more than one route; a patch of a field that several types declare is not attributed to a type`,
  run: (input) => only("mutation-shared-field", input),
});

/** The checks `gaugeline query --mutations` adds. They read the mutations in a QueryInput. */
export const MUTATION_CHECKS: readonly Check<QueryInput>[] = [
  mutationUndeclaredField,
  mutationMissingRequired,
  mutationRefAsString,
  mutationNoDrafts,
  mutationSharedField,
];

/** Only the five mutation checks, for a run that asks the dataset nothing. */
export function createMutationsRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const c of MUTATION_CHECKS) registry.register(c);
  return registry;
}
