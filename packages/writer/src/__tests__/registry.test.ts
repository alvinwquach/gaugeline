/**
 * The registry (ADR-0010 part 1): six endpoints, each a fixed path and body shape, frozen all the way
 * down. Every refusal below has exactly ONE fault against an otherwise valid request (the valid one is
 * checked to pass first), so removing any one guard in checkRequest fails the test that names it.
 */
import { describe, expect, it } from "vitest";
import { checkRequest, ENDPOINTS, type GithubRequest } from "../github/endpoints.js";
import { DRAFT } from "./helpers.js";

const R = "/repos/northgate-studio/tidewater-bar";
const BRANCH = `gaugeline/${DRAFT}`;
const SHA = "b".repeat(40);

const valid: Record<string, GithubRequest> = {
  getRef: { endpoint: "getRef", path: `${R}/git/ref/heads/main` },
  getContent: {
    endpoint: "getContent",
    path: `${R}/contents/app/menu/links.ts`,
    query: { ref: "main" },
  },
  listPulls: {
    endpoint: "listPulls",
    path: `${R}/pulls`,
    query: { head: `northgate-studio:${BRANCH}`, state: "all" },
  },
  createRef: {
    endpoint: "createRef",
    path: `${R}/git/refs`,
    body: { ref: `refs/heads/${BRANCH}`, sha: SHA },
  },
  putContent: {
    endpoint: "putContent",
    path: `${R}/contents/app/menu/links.ts`,
    body: { message: "m", content: "eA==", branch: BRANCH },
  },
  createPull: {
    endpoint: "createPull",
    path: `${R}/pulls`,
    body: { title: "t", head: BRANCH, base: "main", body: "b", draft: true },
  },
};
const withBody = (id: string, body: Record<string, unknown>): GithubRequest => ({
  ...valid[id]!,
  body: { ...valid[id]!.body, ...body },
});
const withoutKey = (id: string, key: string): GithubRequest => {
  const body = { ...valid[id]!.body };
  delete body[key];
  return { ...valid[id]!, body };
};

describe("the registry: six endpoints", () => {
  it("names exactly the reads and writes the writer needs", () => {
    expect(Object.entries(ENDPOINTS).map(([id, e]) => `${e.method} ${id}`)).toEqual([
      "GET getRef",
      "GET getContent",
      "GET listPulls",
      "POST createRef",
      "PUT putContent",
      "POST createPull",
    ]);
  });

  for (const [id, req] of Object.entries(valid))
    it(`accepts a valid ${id}`, () => {
      expect(() => checkRequest(req)).not.toThrow();
    });
});

describe("each guard refuses its own fault", () => {
  const refused: [string, GithubRequest][] = [
    // Which endpoint, which path.
    ["an endpoint that is not registered", { ...valid.getRef!, endpoint: "nope" as never }],
    [
      "an inherited property name as the endpoint",
      { ...valid.getRef!, endpoint: "toString" as never },
    ],
    ["a path that is not text", { ...valid.getRef!, path: 7 as never }],
    ["a path outside /repos", { ...valid.listPulls!, path: "/user/pulls" }],
    [
      "a pull request action path under createPull",
      { ...valid.createPull!, path: `${R}/pulls/1/labels` },
    ],
    ["the reviews path under createPull", { ...valid.createPull!, path: `${R}/pulls/1/reviews` }],
    [
      "a pull request path sent as a putContent",
      { ...valid.putContent!, path: `${R}/pulls/7/labels` },
    ],
    ["an owner with a dot", { ...valid.listPulls!, path: "/repos/a.b/site/pulls" }],
    ["getRef under git/refs", { ...valid.getRef!, path: `${R}/git/refs/heads/x` }],
    // A file path (the registry's own check, with a body that is otherwise valid).
    ["a workflow file", { ...valid.putContent!, path: `${R}/contents/.github/workflows/ci.yml` }],
    ["a hook file", { ...valid.putContent!, path: `${R}/contents/.husky/pre-commit` }],
    [
      "a file path with a malformed escape",
      { ...valid.getContent!, path: `${R}/contents/a%E0%A4%A.ts` },
    ],
    ["a read of a workflow file", { ...valid.getContent!, path: `${R}/contents/.github/x.yml` }],
    // Query keys.
    [
      "a query key the endpoint does not list",
      { ...valid.getContent!, query: { ref: "main", access_token: "x" } },
    ],
    ["a query on a write", { ...valid.putContent!, query: { branch: "main" } }],
    // Bodies.
    ["a body on a read", { ...valid.getRef!, body: {} }],
    ["force: true on createRef", withBody("createRef", { force: true })],
    [
      "maintainer_can_modify on createPull",
      withBody("createPull", { maintainer_can_modify: true }),
    ],
    ["issue (convert an issue) on createPull", withBody("createPull", { issue: 5 })],
    ["committer on putContent", withBody("putContent", { committer: { name: "x" } })],
    ["a missing ref", withoutKey("createRef", "ref")],
    ["a missing sha on createRef", withoutKey("createRef", "sha")],
    ["a missing branch on putContent", withoutKey("putContent", "branch")],
    ["a missing draft flag", withoutKey("createPull", "draft")],
    ["a missing title", withoutKey("createPull", "title")],
    ["a missing base", withoutKey("createPull", "base")],
    ["a missing body", withoutKey("createPull", "body")],
    ["a missing commit message", withoutKey("putContent", "message")],
    ["a missing content", withoutKey("putContent", "content")],
    // Values.
    ["a ref on the default branch", withBody("createRef", { ref: "refs/heads/main" })],
    ["a tag", withBody("createRef", { ref: "refs/tags/gaugeline/x" })],
    ["a ref that climbs", withBody("createRef", { ref: "refs/heads/gaugeline/../main" })],
    ["a ref with a trailing newline", withBody("createRef", { ref: `refs/heads/${BRANCH}\n` })],
    ["a createRef sha that is not 40 hex digits", withBody("createRef", { sha: "b" })],
    ["a createRef sha that is empty", withBody("createRef", { sha: "" })],
    ["a putContent branch that is main", withBody("putContent", { branch: "main" })],
    ["a putContent branch that starts with a dash", withBody("putContent", { branch: "-x" })],
    ["a putContent sha that is not 40 hex digits", withBody("putContent", { sha: "nope" })],
    ["a pull request that is not a draft", withBody("createPull", { draft: false })],
    ["a draft flag that is the text true", withBody("createPull", { draft: "true" })],
    ["a pull request from main", withBody("createPull", { head: "main" })],
    [
      "a pull request from another branch of gaugeline",
      withBody("createPull", { head: "gaugeline/a/b" }),
    ],
  ];
  for (const [name, req] of refused)
    it(`refuses ${name}`, () => {
      expect(() => checkRequest(req)).toThrow(/refused/);
    });

  it("accepts a putContent update that carries the file's blob sha", () => {
    expect(() => checkRequest(withBody("putContent", { sha: SHA }))).not.toThrow();
  });
});

describe("an encoded dot or slash in a file path is refused by the pattern, not by luck", () => {
  // "a%2e%2e" decodes to "a..", which the file-path policy alone would let through.
  for (const encoded of ["a%2e%2e", "docs%2fb.md", "docs%5cb.md", "a%2E%2E", "%2e"])
    it(`refuses ${encoded}`, () => {
      for (const endpoint of ["getContent", "putContent"] as const) {
        const req =
          endpoint === "getContent"
            ? { endpoint, path: `${R}/contents/${encoded}`, query: { ref: "main" } }
            : {
                endpoint,
                path: `${R}/contents/${encoded}`,
                body: { message: "m", content: "Yg==", branch: "gaugeline/x" },
              };
        expect(() => checkRequest(req)).toThrow(/dot, empty or encoded/);
      }
    });
});

describe("a branch name is plain", () => {
  for (const name of ["a..b", "refs/heads/main", "main.lock", "a//b", "a/", "@{u}", "a b", "main."])
    it(`getRef refuses ${JSON.stringify(name)}`, () => {
      expect(() =>
        checkRequest({ endpoint: "getRef", path: `${R}/git/ref/heads/${name}` }),
      ).toThrow(/refused/);
    });
  it("getRef accepts main and release/2026.11", () => {
    for (const name of ["main", "release/2026.11", "feat/x_y-z"])
      expect(() =>
        checkRequest({ endpoint: "getRef", path: `${R}/git/ref/heads/${name}` }),
      ).not.toThrow();
  });
});

describe("dot segments never reach the URL parser", () => {
  const climbs = [
    `${R}/git/ref/heads/../../../../../user`,
    `${R}/git/ref/heads/../../../../../orgs/acme/members`,
    `${R}/git/ref/heads/./main`,
    `${R}/git/ref/heads//main`,
    `${R}/git/ref/heads/main/`,
    `${R}/git/ref/heads/%2e%2e/%2e%2e/user`,
    `${R}/git/ref/heads/..%2fuser`,
    `${R}/git/ref/heads/a%5cb`,
    "/repos/acme/../pulls",
    "/repos/acme/./pulls",
    "/repos/../site/pulls",
  ];
  for (const path of climbs)
    it(`refuses ${path}`, () => {
      expect(() => checkRequest({ endpoint: "getRef", path })).toThrow(/refused/);
      expect(() => checkRequest({ endpoint: "listPulls", path })).toThrow(/refused/);
    });

  it("refuses a repository called .. even for a path that otherwise matches", () => {
    expect(() =>
      checkRequest({ endpoint: "listPulls", path: "/repos/northgate-studio/../pulls" }),
    ).toThrow(/refused/);
  });
});

describe("the registry cannot be rewritten by code that imports it", () => {
  const attempts: [string, () => void][] = [
    ["change a method", () => void ((ENDPOINTS.getRef as { method: string }).method = "DELETE")],
    ["add an endpoint", () => void ((ENDPOINTS as Record<string, unknown>).extra = {})],
    ["replace an endpoint", () => void ((ENDPOINTS as Record<string, unknown>).getRef = {})],
    ["delete an endpoint", () => void delete (ENDPOINTS as Record<string, unknown>).getRef],
    [
      "push a body key",
      () => (ENDPOINTS.createPull.body as string[]).push("maintainer_can_modify"),
    ],
    ["push a required key", () => (ENDPOINTS.createPull.required as string[]).push("x")],
    ["push a query key", () => (ENDPOINTS.getContent.query as string[]).push("access_token")],
    ["replace a body key", () => void ((ENDPOINTS.createRef.body as string[])[0] = "force")],
    [
      "replace the path pattern",
      () => void ((ENDPOINTS.putContent as { rest: string }).rest = "^/pulls/.*$"),
    ],
    [
      "recompile the path pattern",
      () => (ENDPOINTS.putContent.rest as unknown as RegExp).compile("^/pulls/1/labels$"),
    ],
  ];
  for (const [name, attempt] of attempts)
    it(`cannot ${name}`, () => {
      expect(attempt).toThrow();
    });

  it("is frozen at every level", () => {
    expect(Object.isFrozen(ENDPOINTS)).toBe(true);
    for (const e of Object.values(ENDPOINTS)) {
      expect(Object.isFrozen(e)).toBe(true);
      for (const list of [e.query, e.body, e.required])
        if (list) expect(Object.isFrozen(list)).toBe(true);
      expect(typeof e.rest).toBe("string");
    }
  });

  it("still names exactly the same six requests after every attempt", () => {
    for (const [, attempt] of attempts) {
      try {
        attempt();
      } catch {
        /* refused, as it should be */
      }
    }
    expect(() => checkRequest(valid.putContent!)).not.toThrow();
    expect(() => checkRequest({ ...valid.putContent!, path: `${R}/pulls/7/labels` })).toThrow();
    expect(() => checkRequest(withBody("createPull", { maintainer_can_modify: true }))).toThrow();
    expect(Object.keys(ENDPOINTS)).toHaveLength(6);
  });
});
