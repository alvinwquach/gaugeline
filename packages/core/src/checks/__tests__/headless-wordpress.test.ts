import { describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { NetworkError } from "../../errors.js";
import { createFetcher, type Hop } from "../../fetcher.js";
import {
  draftMarker,
  endsAtLogin,
  graphqlCandidates,
  isHeadlessWordPress,
  looksPrivate,
  previewLinks,
  readIntrospection,
  readNextData,
  readOnlyProbe,
  scanState,
} from "../../headless-wordpress/detect.js";
import { createBudget } from "../../limits.js";
import type { CheckContext } from "../../model.js";
import { checkSite } from "../../site.js";
import { buildSnapshot } from "../../snapshot.js";
import { headlessWpIntrospectionOpen } from "../headless-wp-introspection-open.js";
import { headlessWpPreviewCanonical } from "../headless-wp-preview-canonical.js";
import { headlessWpPreviewOpen } from "../headless-wp-preview-open.js";
import { headlessWpPrivateFields } from "../headless-wp-private-fields.js";

const IDS = [
  "headless-wp-introspection-open",
  "headless-wp-preview-canonical",
  "headless-wp-preview-open",
  "headless-wp-private-fields",
];

const state = (json: string) =>
  `<script id="__NEXT_DATA__" type="application/json">${json}</script>`;
const FAUST_STATE = state(
  '{"props":{"pageProps":{"__APOLLO_STATE__":{"Post:1":{"__typename":"Post","title":"A","status":"publish"}}}}}',
);
const html = (body: string, headers: Record<string, string> = {}) => ({
  status: 200,
  headers: { "content-type": "text/html", ...headers },
  body,
  ms: 1,
});
function page(url: string, body: string) {
  return buildSnapshot([{ url, ...html(body) }]);
}
const HEADLESS = `<html><head><script src="/_next/static/chunks/main.js"></script></head><body><main>Hi</main>${FAUST_STATE}</body></html>`;

describe("headless wordpress: unit", () => {
  it("recognises a Faust.js page from its WordPress state, and not a classic theme or a plain Next.js page", () => {
    expect(isHeadlessWordPress(page("https://pop.example/", HEADLESS))).toBe(true);
    const next =
      '<script src="/_next/static/a.js"></script><img src="https://cms.pop.example/wp-content/uploads/a.jpg">';
    expect(isHeadlessWordPress(page("https://pop.example/", next))).toBe(true);
    expect(
      isHeadlessWordPress(
        page("https://pop.example/", `${HEADLESS}<link href="/wp-content/themes/x/s.css">`),
      ),
    ).toBe(false);
    expect(
      isHeadlessWordPress(
        page("https://pop.example/", '<script src="/_next/static/a.js"></script>'),
      ),
    ).toBe(false);
    expect(isHeadlessWordPress(page("https://pop.example/", "<p>plain</p>"))).toBe(false);
  });

  it("the introspection probe is one query and a mutation is refused", () => {
    expect(readOnlyProbe()).toBe("{__schema{queryType{name}}}");
    expect(() => readOnlyProbe("mutation{deletePost(input:{id:1}){id}}")).toThrow(TypeError);
    expect(() => readOnlyProbe("{a} {b}")).toThrow(TypeError);
  });

  it("reads an introspection answer: open, closed, or unread", () => {
    const j = "application/json";
    expect(
      readIntrospection('{"data":{"__schema":{"queryType":{"name":"RootQuery"}}}}', false, j),
    ).toEqual({
      state: "open",
      rootType: "RootQuery",
    });
    // WPGraphQL answers 200 with an errors array when introspection is off.
    expect(readIntrospection('{"errors":[{"message":"off"}],"data":null}', false, j)).toEqual({
      state: "closed",
    });
    expect(readIntrospection("<html>", false, "text/html").state).toBe("unread");
    expect(readIntrospection("{", false, j).state).toBe("unread");
    expect(readIntrospection('{"data":{}}', false, j).state).toBe("unread");
    expect(readIntrospection("{}", true, j).state).toBe("unread");
    expect(readIntrospection(`{"x":"${"a".repeat(200_000)}"}`, false, j).state).toBe("unread");
  });

  it("finds preview links on the page's own origin only, without repeats, at most three", () => {
    const links = [
      "/a?preview=true&p=1",
      "/a?preview=true&p=1",
      "/b?previewId=2",
      "/c?preview_id=3",
      "/d?preview=true",
      "https://other.example/e?preview=true",
      "/plain?p=1",
    ]
      .map((h) => `<a href="${h}">x</a>`)
      .join("");
    const found = previewLinks(page("https://pop.example/", `<body>${links}</body>`));
    expect(found).toEqual([
      "https://pop.example/a?preview=true&p=1",
      "https://pop.example/b?previewId=2",
      "https://pop.example/c?preview_id=3",
    ]);
  });

  it("graphql candidates: the site's own, and the back end its uploads come from", () => {
    const p = page(
      "https://pop.example/",
      `${HEADLESS}<img src="https://cms.pop.example/wp-content/uploads/a.jpg">`,
    );
    expect(graphqlCandidates(p)).toEqual([
      "https://pop.example/graphql",
      "https://cms.pop.example/graphql",
    ]);
  });

  it("a login address or a login form is a login", () => {
    expect(endsAtLogin([{ url: "https://pop.example/wp-login.php?redirect_to=x" }])).toBe(true);
    expect(endsAtLogin([{ url: "https://pop.example/a", body: '<input type="password">' }])).toBe(
      true,
    );
    expect(endsAtLogin([{ url: "https://pop.example/specials", body: "<p>hi</p>" }])).toBe(false);
  });

  it("draft markers: data status, isPreview, title; a published page has none", () => {
    expect(draftMarker('{"status":"draft"}')).toMatch(/status draft/);
    expect(draftMarker('{"isPreview":true}')).toMatch(/isPreview/);
    expect(draftMarker("<title>Auto Draft</title>")).toMatch(/draft title/);
    expect(draftMarker('<title>Menu</title>{"status":"publish"}')).toBeUndefined();
  });

  it("names that look private are found by their words; flags are not", () => {
    for (const n of [
      "password",
      "apiToken",
      "api_key",
      "refreshToken",
      "secretKey",
      "internalNotes",
      "authorization",
    ])
      expect(looksPrivate(n), n).toBe(true);
    for (const n of ["title", "isPrivate", "hasToken", "slug", "authorName", "saltedCaramel"])
      expect(looksPrivate(n), n).toBe(false);
  });

  it("scans the state: private names, a User's private fields, unpublished counts; names only", () => {
    const s = scanState({
      a: { __typename: "User", email: "private-value-one", name: "N", roles: ["editor"] },
      b: [{ status: "draft" }, { status: "draft" }, { status: "publish" }],
      c: { apiToken: "v" },
      d: { __typename: "Post", email: "private-value-two" },
    });
    expect(s.names).toEqual(["User.email", "User.roles", "apiToken"]);
    expect([...s.unpublished]).toEqual([["draft", 2]]);
    expect(JSON.stringify(s)).not.toMatch(/private-value-/);
  });
});

describe("headless wordpress: integration (the headless-wp fixture)", () => {
  const run = async (ownerConsent: boolean) => {
    const site = await startFixture("headless-wp");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts }),
        only: IDS,
        ...(ownerConsent ? { ownerConsent: true } : {}),
      });
      return { result, hits: site.hits, methods: site.methods, query: undefined };
    } finally {
      await site.close();
    }
  };

  it("without consent only the two rules that read the page run, and nothing is asked", async () => {
    const { result, hits } = await run(false);
    expect(result.findings.map((f) => [f.checkId, f.evidence])).toEqual([
      [
        "headless-wp-preview-canonical",
        expect.stringMatching(
          /^canonical http:\/\/saltmarsh\.test\/\?p=12&preview=true is a preview link$/,
        ),
      ],
      [
        "headless-wp-private-fields",
        "the embedded state has User.email, User.roles, apiToken; it holds posts that are not published (1 draft) (field names and counts only)",
      ],
    ]);
    expect(hits.has("/graphql")).toBe(false);
    expect(result.failed).toEqual([]);
  });

  it("with consent the introspection answer and the open preview are found, by GET only", async () => {
    const { result, hits, methods } = await run(true);
    const found = result.findings.map((f) => [f.checkId, f.evidence]);
    expect(found).toContainEqual([
      "headless-wp-introspection-open",
      expect.stringMatching(
        /\/graphql answers an introspection query with its schema \(root type RootQuery\) with no login$/,
      ),
    ]);
    expect(found).toContainEqual([
      "headless-wp-preview-open",
      "/specials (query: p, preview, previewPathname) answered 200 with no login and status draft in its data",
    ]);
    expect(hits.get("/graphql")).toBe(1);
    expect([...methods.keys()].filter((m) => m !== "GET" && m !== "HEAD")).toEqual([]);
  });
});

describe("headless wordpress: edge cases", () => {
  const fetcherFor = (answers: Record<string, Partial<Hop>>, asked: string[] = []) => ({
    get: async (url: string) => {
      asked.push(url);
      const hit = Object.entries(answers).find(([k]) => url.startsWith(k))?.[1];
      if (!hit) throw new NetworkError("unreachable", { url });
      return [{ url, status: 200, headers: {}, body: "", ms: 1, ...hit }];
    },
    getSite: async () => [],
    stats: { requests: 0, maxInFlight: 0 },
  });
  const ctxFor = (
    answers: Record<string, Partial<Hop>>,
    over: Partial<CheckContext> = {},
    asked: string[] = [],
    unread: string[] = [],
  ): CheckContext => ({
    warn: () => undefined,
    budget: createBudget(),
    fetcher: fetcherFor(answers, asked),
    couldNotCheck: (_u, r) => void unread.push(r),
    ownerConsent: true,
    ...over,
  });
  const JSON_TYPE = { "content-type": "application/json" };

  it("introspection disabled (a 200 with an errors body) is not reported", async () => {
    const asked: string[] = [];
    const ctx = ctxFor(
      {
        "https://pop.example/graphql": {
          headers: JSON_TYPE,
          body: '{"errors":[{"message":"disabled"}]}',
        },
      },
      {},
      asked,
    );
    expect(
      await headlessWpIntrospectionOpen.run(page("https://pop.example/", HEADLESS), ctx),
    ).toEqual([]);
    // The query was in the address, a constant, and a GET: the fetcher has no other method.
    expect(decodeURIComponent(asked[0] ?? "")).toContain("?query={__schema{queryType{name}}}");
  });

  it("a POST-only endpoint (405) and a huge answer are could not check, not findings", async () => {
    const unread: string[] = [];
    const post = ctxFor({ "https://pop.example/graphql": { status: 405 } }, {}, [], unread);
    expect(
      await headlessWpIntrospectionOpen.run(page("https://pop.example/", HEADLESS), post),
    ).toEqual([]);
    const huge = ctxFor(
      {
        "https://pop.example/graphql": {
          headers: JSON_TYPE,
          body: "{" + "a".repeat(200_000),
          truncated: true,
        },
      },
      {},
      [],
      unread,
    );
    expect(
      await headlessWpIntrospectionOpen.run(page("https://pop.example/", HEADLESS), huge),
    ).toEqual([]);
    expect(unread).toEqual([
      "the endpoint answered 405 to a GET",
      "the answer is larger than a probe answer should be",
    ]);
  });

  it("a 404 at /graphql means no endpoint is there: nothing is said", async () => {
    const unread: string[] = [];
    const ctx = ctxFor({ "https://pop.example/graphql": { status: 404 } }, {}, [], unread);
    expect(
      await headlessWpIntrospectionOpen.run(page("https://pop.example/", HEADLESS), ctx),
    ).toEqual([]);
    expect(unread).toEqual([]);
  });

  it("without consent nothing is requested and the reason is recorded", async () => {
    const asked: string[] = [];
    const unread: string[] = [];
    const ctx = ctxFor({}, { ownerConsent: false }, asked, unread);
    const p = page("https://pop.example/", `${HEADLESS}<a href="/a?preview=true">x</a>`);
    expect(await headlessWpIntrospectionOpen.run(p, ctx)).toEqual([]);
    expect(await headlessWpPreviewOpen.run(p, ctx)).toEqual([]);
    expect(asked).toEqual([]);
    expect(unread).toHaveLength(2);
    expect(unread.every((r) => /--owner-consent/.test(r))).toBe(true);
  });

  it("a preview address that redirects to the login, or answers 401, is not reported", async () => {
    const p = page("https://pop.example/", `${HEADLESS}<a href="/a?p=1&preview=true">x</a>`);
    const login = {
      get: async (url: string): Promise<Hop[]> => [
        { url, status: 302, headers: { location: "/wp-login.php" }, body: "", ms: 1 },
        {
          url: "https://pop.example/wp-login.php",
          status: 200,
          headers: { "content-type": "text/html" },
          body: '<input type="password">',
          ms: 1,
        },
      ],
      getSite: async () => [],
      stats: { requests: 0, maxInFlight: 0 },
    };
    expect(await headlessWpPreviewOpen.run(p, ctxFor({}, { fetcher: login }))).toEqual([]);
    expect(
      await headlessWpPreviewOpen.run(p, ctxFor({ "https://pop.example/a": { status: 401 } })),
    ).toEqual([]);
  });

  it("a preview address that answers a page with no draft marker is could not check, never a finding", async () => {
    const unread: string[] = [];
    const p = page("https://pop.example/", `${HEADLESS}<a href="/a?p=1&preview=true">x</a>`);
    const ctx = ctxFor(
      {
        "https://pop.example/a": {
          headers: { "content-type": "text/html" },
          body: "<title>Menu</title>",
        },
      },
      {},
      [],
      unread,
    );
    expect(await headlessWpPreviewOpen.run(p, ctx)).toEqual([]);
    expect(unread).toEqual([
      "the preview address answered with a page and no sign of whether it is a draft",
    ]);
  });

  it("the preview finding shows parameter names and never their values", async () => {
    const p = page(
      "https://pop.example/",
      `${HEADLESS}<a href="/a?p=1&preview=true&preview_nonce=SECRETNONCE">x</a>`,
    );
    const ctx = ctxFor({
      "https://pop.example/a": {
        headers: { "content-type": "text/html" },
        body: '{"status":"draft"}',
      },
    });
    const out = await headlessWpPreviewOpen.run(p, ctx);
    expect(out).toHaveLength(1);
    expect(JSON.stringify(out)).not.toMatch(/SECRETNONCE/);
  });

  it("on a site that is not headless WordPress, every check is silent and nothing is requested", async () => {
    const asked: string[] = [];
    const plain = page(
      "https://pop.example/",
      '<link rel="canonical" href="https://x.netlify.app/"><a href="/a?preview=true">x</a>',
    );
    for (const c of [
      headlessWpIntrospectionOpen,
      headlessWpPreviewOpen,
      headlessWpPreviewCanonical,
      headlessWpPrivateFields,
    ])
      expect(await c.run(plain, ctxFor({}, {}, asked)), c.id).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("hostile state: __proto__ and constructor keys, lone surrogates, deep nesting and big arrays", () => {
    const bad = state(
      '{"__proto__":{"password":"x"},"constructor":{"token":"y"},"s":"\\ud800","apiToken\\ud800":1}',
    );
    const p = page("https://pop.example/", `<script src="/_next/static/a.js"></script>${bad}`);
    const data = readNextData(p);
    expect(data && "json" in data).toBe(true);
    const scan = scanState(data && "json" in data ? data.json : undefined);
    expect(scan.names).toEqual(["apiToken?", "password", "token"]);
    expect(({} as Record<string, unknown>).password).toBeUndefined();
    // Nesting past the depth cap is a floor, said so, and never a stack overflow.
    expect(scanState(JSON.parse(`{"a":${"[".repeat(5000)}${"]".repeat(5000)}}`)).capped).toBe(true);
    const big = scanState({ a: Array.from({ length: 150_000 }, () => ({ b: 1 })) });
    expect(big.capped).toBe(true);
  });

  it("a state that is cut, invalid or over 1 MB is could not check", async () => {
    const unread: string[] = [];
    const ctx = ctxFor({}, {}, [], unread);
    const next =
      '<script src="/_next/static/a.js"></script><img src="https://cms.pop.example/wp-content/uploads/a.jpg">';
    for (const body of [
      `${next}<script id="__NEXT_DATA__" type="application/json">{"a":`,
      `${next}${state("{not json")}`,
      `${next}${state(`{"a":"${"x".repeat(1_100_000)}"}`)}`,
    ])
      expect(await headlessWpPrivateFields.run(page("https://pop.example/", body), ctx)).toEqual(
        [],
      );
    expect(unread).toEqual([
      "the embedded state has no end",
      "the embedded state is not valid JSON",
      "the embedded state is larger than 1 MB, so it was not read",
    ]);
  });

  it("preview canonical: a WordPress preview link as canonical is found; a production canonical is not", async () => {
    const ctx = ctxFor({});
    const bad = page(
      "https://pop.example/",
      `<link rel="canonical" href="https://pop.example/a?p=1&preview=true">${HEADLESS}`,
    );
    expect((await headlessWpPreviewCanonical.run(bad, ctx)).map((f) => f.evidence)).toEqual([
      "canonical https://pop.example/a?p=1&preview=true is a preview link",
    ]);
    const good = page(
      "https://pop.example/",
      `<link rel="canonical" href="https://pop.example/">${HEADLESS}`,
    );
    expect(await headlessWpPreviewCanonical.run(good, ctx)).toEqual([]);
  });
});
