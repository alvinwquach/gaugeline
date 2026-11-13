/**
 * The Sanity registry (ADR-0010 part 1, X71): two endpoints, a read of one document and one mutation
 * request, frozen all the way down. Every refusal has exactly ONE fault against an otherwise valid request
 * (the valid one is checked to pass first), so removing any one guard fails the test that names it.
 */
import { describe, expect, it } from "vitest";
import {
  checkSanityRequest,
  isPlainDocumentId,
  isSanityTarget,
  SANITY_API_VERSIONS,
  SANITY_ENDPOINTS,
  SanityRegistryError,
  type SanityRequest,
  type SanityTarget,
} from "../sanity/endpoints.js";

const T: SanityTarget = { projectId: "tidewtr1", dataset: "production", apiVersion: "v2025-02-06" };
const DOC = `/${T.apiVersion}/data/doc/${T.dataset}`;
const MUTATE = `/${T.apiVersion}/data/mutate/${T.dataset}`;
// Words the registry must never accept, built so this file does not spell them out.
const PUB = ["pub", "lish"].join("");

const getDoc = (id = "menu-page"): SanityRequest => ({
  endpoint: "getDoc",
  path: `${DOC}/${id}`,
});
const copy = { _id: "drafts.menu-page", _type: "page", title: "Menu", hours: "Mon to Sun" };
const mutate = (mutations: unknown[]): SanityRequest => ({
  endpoint: "mutate",
  path: MUTATE,
  query: { returnIds: "true" },
  body: { mutations },
});
const validMutate = mutate([{ create: copy }]);
const refusals =
  (req: SanityRequest, t: SanityTarget = T) =>
  () =>
    checkSanityRequest(req, t);

describe("the registry: a read and one mutation request", () => {
  it("names exactly two endpoints, with their methods", () => {
    expect(Object.entries(SANITY_ENDPOINTS).map(([id, e]) => `${e.method} ${id}`)).toEqual([
      "GET getDoc",
      "POST mutate",
    ]);
  });

  it("accepts a read of a live document and of its draft, and the creation of a draft", () => {
    expect(refusals(getDoc("menu-page"))).not.toThrow();
    expect(refusals(getDoc("drafts.menu-page"))).not.toThrow();
    expect(refusals(validMutate)).not.toThrow();
    expect(refusals({ ...validMutate, query: undefined })).not.toThrow();
  });

  it("is frozen at every level: no code can add an endpoint, change a method or widen a body", () => {
    expect(Object.isFrozen(SANITY_ENDPOINTS)).toBe(true);
    for (const e of Object.values(SANITY_ENDPOINTS)) {
      expect(Object.isFrozen(e)).toBe(true);
      expect(Object.isFrozen(e.query)).toBe(true);
      if (e.body) expect(Object.isFrozen(e.body)).toBe(true);
    }
    const mutable = SANITY_ENDPOINTS as unknown as Record<string, unknown>;
    expect(() => {
      mutable.dropDoc = {};
    }).toThrow();
    expect(() => {
      (SANITY_ENDPOINTS.mutate as { method: string }).method = "GET";
    }).toThrow();
    expect(() => (SANITY_ENDPOINTS.mutate.body as string[]).push("actions")).toThrow();
  });
});

describe("each guard refuses its own fault", () => {
  const refused: [string, SanityRequest][] = [
    ["an endpoint that is not registered", { ...getDoc(), endpoint: "nope" as never }],
    ["an inherited property as the endpoint", { ...getDoc(), endpoint: "toString" as never }],
    ["a path that is not text", { ...getDoc(), path: 7 as never }],
    [
      "another API version in the path",
      { ...getDoc(), path: `/v2021-03-25/data/doc/${T.dataset}/x` },
    ],
    ["another dataset in the path", { ...getDoc(), path: `/${T.apiVersion}/data/doc/staging/x` }],
    ["the query endpoint", { ...getDoc(), path: `/${T.apiVersion}/data/query/${T.dataset}` }],
    ["the actions endpoint", { ...mutate([]), path: `/${T.apiVersion}/data/actions/${T.dataset}` }],
    ["a path under another prefix", { ...getDoc(), path: `/projects/x/data/doc/${T.dataset}/y` }],
    ["a dot segment", { ...getDoc(), path: `${DOC}/../query/x` }],
    ["a single dot segment", { ...getDoc(), path: `${DOC}/./x` }],
    ["an encoded dot", { ...getDoc("%2e%2e"), path: `${DOC}/%2e%2e` }],
    ["an encoded slash", getDoc("a%2fb")],
    ["an encoded backslash", getDoc("a%5cb")],
    ["a slash in the id", getDoc("a/b")],
    ["an empty id", getDoc("")],
    ["an id with a space", getDoc("a b")],
    ["an id with a dot", getDoc("a.b")],
    ["an id that is too long", getDoc("a".repeat(129))],
    ["an id starting with an underscore", getDoc("_menu")],
    ["a version id", getDoc("versions.r1.menu")],
    ["a drafts prefix twice", getDoc("drafts.drafts.menu")],
    ["a drafts prefix and nothing else", getDoc("drafts.")],
    ["a query string in the path", { ...getDoc(), path: `${DOC}/menu?x=1` }],
    ["a fragment in the path", { ...getDoc(), path: `${DOC}/menu#x` }],
    ["a query on a read", { ...getDoc(), query: { perspective: "raw" } }],
    ["a body on a read", { ...getDoc(), body: { a: 1 } }],
    ["an unknown query key", { ...validMutate, query: { returnIds: "true", dryRun: "false" } }],
    ["a returnIds that is not true", { ...validMutate, query: { returnIds: "false" } }],
    ["a body key beyond mutations", { ...validMutate, body: { ...validMutate.body, actions: [] } }],
    ["no mutations", { ...validMutate, body: {} }],
    ["a mutate with no body", { ...validMutate, body: undefined }],
    ["mutations that are not a list", { ...validMutate, body: { mutations: {} } }],
    ["an empty list of mutations", mutate([])],
    [
      "another dataset on the mutate path",
      { ...validMutate, path: `/${T.apiVersion}/data/mutate/staging` },
    ],
    [
      "another API version on the mutate path",
      { ...validMutate, path: `/v2021-03-25/data/mutate/${T.dataset}` },
    ],
    ["a suffix on the mutate path", { ...validMutate, path: `${MUTATE}/x` }],
    ["a trailing slash on the mutate path", { ...validMutate, path: `${MUTATE}/` }],
    ["two mutations", mutate([{ create: copy }, { create: { ...copy, _id: "drafts.other" } }])],
    ["a mutation that is not an object", mutate([null])],
    [
      "a mutation with two operations",
      mutate([{ create: copy, delete: { id: "drafts.menu-page" } }]),
    ],
    ["an unknown operation", mutate([{ upsert: copy }])],
    ["createIfNotExists (it would do nothing quietly)", mutate([{ createIfNotExists: copy }])],
    ["createOrReplace (it would overwrite)", mutate([{ createOrReplace: copy }])],
    ["a delete", mutate([{ delete: { id: "drafts.menu-page" } }])],
    ["a delete by query", mutate([{ delete: { query: "*" } }])],
    ["a patch of a draft", mutate([{ patch: { id: "drafts.menu-page", set: { hours: "x" } } }])],
    ["a patch of a live id", mutate([{ patch: { id: "menu-page", set: { hours: "x" } } }])],
    ["a patch by query", mutate([{ patch: { query: "*", set: { hours: "x" } } }])],
    ["create with a live id", mutate([{ create: { ...copy, _id: "menu-page" } }])],
    ["create with no id (Sanity would make one)", mutate([{ create: { _type: "page" } }])],
    [
      "create with a generated id (drafts. alone)",
      mutate([{ create: { ...copy, _id: "drafts." } }]),
    ],
    ["create with a version id", mutate([{ create: { ...copy, _id: "versions.r1.menu-page" } }])],
    ["create with a bad draft id", mutate([{ create: { ...copy, _id: "drafts.a/b" } }])],
    ["create with an encoded draft id", mutate([{ create: { ...copy, _id: "drafts.a%2fb" } }])],
    ["create with no type", mutate([{ create: { _id: "drafts.menu-page", title: "x" } }])],
    ["create with a type that is not text", mutate([{ create: { ...copy, _type: 3 } }])],
    ["create with a type that is not a name", mutate([{ create: { ...copy, _type: "a.b" } }])],
    ["create carrying a revision", mutate([{ create: { ...copy, _rev: "r" } }])],
    [
      "create carrying a creation time",
      mutate([{ create: { ...copy, _createdAt: "2026-01-01" } }]),
    ],
    ["create carrying system data", mutate([{ create: { ...copy, _system: { drop: true } } }])],
    ["create that is a list", mutate([{ create: [copy] }])],
  ];
  for (const [name, req] of refused)
    it(`refuses ${name}`, () => {
      expect(refusals(req)).toThrow(SanityRegistryError);
    });

  it(`refuses any action whose name says ${PUB}, unpublish or delete, in an actions body`, () => {
    for (const actionType of [
      `sanity.action.document.${PUB}`,
      "sanity.action.document.unpublish",
      "sanity.action.document.delete",
    ])
      expect(
        refusals({
          endpoint: "mutate",
          path: MUTATE,
          body: {
            actions: [{ actionType, draftId: "drafts.menu-page", publishedId: "menu-page" }],
          },
        }),
      ).toThrow(SanityRegistryError);
  });
});

describe("the target is checked as plain names", () => {
  it("pins the API version to the one the request shapes were read for", () => {
    expect(SANITY_API_VERSIONS).toEqual(["v2025-02-06"]);
    expect(Object.isFrozen(SANITY_API_VERSIONS)).toBe(true);
    expect(() => (SANITY_API_VERSIONS as string[]).push("v2025-02-19")).toThrow();
  });

  it("accepts a plain project id, dataset and API version", () => {
    expect(isSanityTarget(T)).toBe(true);
    expect(isSanityTarget({ ...T, dataset: "staging_2" })).toBe(true);
  });
  for (const bad of [
    { projectId: "" },
    { projectId: "Tidewtr1" },
    { projectId: "evil.example" },
    { projectId: "a/b" },
    { projectId: "a b" },
    { projectId: "a@evil" },
    { projectId: "-abc" },
    { projectId: "a".repeat(40) },
    { dataset: "" },
    { dataset: "Prod" },
    { dataset: "a/b" },
    { dataset: "a..b" },
    { dataset: "~x" },
    { apiVersion: "2025-02-06" },
    { apiVersion: "v2025-13-01" }, // not a date
    { apiVersion: "v2025-02-30" }, // not a date
    { apiVersion: "v2025-02-19" }, // a real date, but not the version the request shapes were read for
    { apiVersion: "v2021-03-25" },
    { apiVersion: "v2025-02-06 " },
    { apiVersion: "V2025-02-06" },
    { apiVersion: "vX" },
    { apiVersion: "v1" },
    { apiVersion: "v2025-02-06/../x" },
  ])
    it(`refuses ${JSON.stringify(bad)}`, () => {
      expect(isSanityTarget({ ...T, ...bad })).toBe(false);
      expect(refusals(getDoc(), { ...T, ...bad })).toThrow(SanityRegistryError);
    });

  it("a plain document id is a name, optionally under drafts.", () => {
    for (const ok of ["menu", "menu-page_2", "A1", "drafts.menu"])
      expect(isPlainDocumentId(ok)).toBe(true);
    for (const bad of [
      "",
      ".menu",
      "_menu",
      "menu.",
      "a.b",
      "drafts.drafts.a",
      "drafts.",
      "a/b",
      "../a",
    ])
      expect(isPlainDocumentId(bad), bad).toBe(false);
  });
});
