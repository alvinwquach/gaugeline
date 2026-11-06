import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SITES_DIR, startFixture } from "../../../../fixtures/src/index.js";
import { ConfigError } from "../../errors.js";
import { createFetcher, type Hop } from "../../fetcher.js";
import { checkBuilt } from "../../plan/built.js";
import { readPlan, type PlanRow } from "../../plan/read.js";
import {
  PREVIEW_AUTH_ENV,
  authHeaders,
  previewAuth,
  protectionMessage,
  protectionOf,
  protectionPage,
} from "../preview-auth.js";

const BASE = "https://preview.example";
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const BASIC = "harbour:glaze-and-fire";
const BYPASS = "gaugeline-fixture-bypass-0001";

const VERCEL_LOGIN =
  '<!doctype html><title>Authentication Required</title><h1>Authentication Required</h1><a href="https://vercel.com/sso-api?url=x">Continue with Vercel</a>';
const NETLIFY_FORM =
  '<!doctype html><title>Password protected</title><form method="post" action="/.netlify/functions/__password"><input type="password" name="password"><button>Visit site</button></form><p>Protected by Netlify</p>';
const ORDINARY =
  "<!doctype html><title>Harbour Pottery</title><h1>Harbour Pottery</h1><p>Classes, a shop and a kiln. Built on Vercel.</p><form><input type=search></form>";

const hop = (status: number, body = "", headers: Record<string, string> = {}): Hop => ({
  url: `${BASE}/`,
  status,
  headers,
  body,
  ms: 1,
});

const plan = () => readPlan(readFileSync(`${SITES_DIR}plan-built/plan.csv`, "utf8"));

describe("preview auth: unit", () => {
  it("each variable alone gives its one header and a describe that never holds the value", () => {
    const v = previewAuth({ [PREVIEW_AUTH_ENV.vercel]: BYPASS }, BASE);
    expect(v?.headers).toEqual({ "x-vercel-protection-bypass": BYPASS });
    expect(v?.describe).toBe("Vercel bypass (set)");

    const b = previewAuth({ [PREVIEW_AUTH_ENV.basic]: BASIC }, BASE);
    expect(b?.headers).toEqual({ authorization: `Basic ${b64(BASIC)}` });
    expect(b?.describe).toBe("basic auth (set)");

    const h = previewAuth({ [PREVIEW_AUTH_ENV.header]: "X-Preview-Token: abc123" }, BASE);
    expect(h?.headers).toEqual({ "x-preview-token": "abc123" });
    expect(h?.describe).toBe("header X-Preview-Token (set)");
    for (const a of [v, b, h]) expect(a?.origin).toBe(BASE);
  });

  it("two set together are both sent; none set is undefined", () => {
    const both = previewAuth(
      { [PREVIEW_AUTH_ENV.vercel]: BYPASS, [PREVIEW_AUTH_ENV.basic]: BASIC },
      BASE,
    );
    expect(Object.keys(both?.headers ?? {})).toEqual([
      "x-vercel-protection-bypass",
      "authorization",
    ]);
    expect(both?.describe).toBe("Vercel bypass (set), basic auth (set)");
    expect(previewAuth({}, BASE)).toBeUndefined();
    expect(previewAuth({ [PREVIEW_AUTH_ENV.basic]: "  " }, BASE)).toBeUndefined();
  });

  it("a malformed GAUGELINE_BASIC_AUTH or GAUGELINE_PREVIEW_HEADER is a ConfigError naming the variable, not its value", () => {
    const bad = (env: Record<string, string>) => {
      try {
        previewAuth(env, BASE);
      } catch (err) {
        return err as ConfigError;
      }
      throw new Error("expected a ConfigError");
    };
    const basic = bad({ [PREVIEW_AUTH_ENV.basic]: "no-colon-secret-123" });
    expect(basic).toBeInstanceOf(ConfigError);
    expect(basic.message).toBe('GAUGELINE_BASIC_AUTH is not in the form "user:password".');
    expect(`${basic.message} ${basic.hint ?? ""}`).not.toContain("no-colon-secret-123");

    const header = bad({ [PREVIEW_AUTH_ENV.header]: "header-without-colon-456" });
    expect(header.message).toBe('GAUGELINE_PREVIEW_HEADER is not in the form "Name: value".');
    expect(`${header.message} ${header.hint ?? ""}`).not.toContain("header-without-colon-456");
  });

  it("the protection page detector: Vercel login, Netlify password form, an ordinary page", () => {
    expect(protectionPage(VERCEL_LOGIN)).toBe("vercel");
    expect(protectionPage(NETLIFY_FORM)).toBe("netlify");
    expect(protectionPage(ORDINARY)).toBeUndefined();
    expect(protectionOf(hop(200, VERCEL_LOGIN))).toEqual({
      kind: "password",
      status: 200,
      platform: "vercel",
    });
    expect(protectionOf(hop(200, ORDINARY))).toBeUndefined();
  });

  it("the provider sends headers to the base origin only", () => {
    const auth = previewAuth({ [PREVIEW_AUTH_ENV.vercel]: BYPASS }, BASE);
    if (!auth) throw new Error("expected auth");
    const at = authHeaders(auth);
    expect(at(new URL(`${BASE}/shop`))).toEqual({ "x-vercel-protection-bypass": BYPASS });
    expect(at(new URL("https://preview.example:8443/shop"))).toBeUndefined();
    expect(at(new URL("http://preview.example/shop"))).toBeUndefined();
    expect(at(new URL("https://cdn.example/shop"))).toBeUndefined();
  });
});

describe("preview auth: integration (the protected fixtures)", () => {
  for (const [name, env, header, hint] of [
    [
      "preview-basic-auth",
      { [PREVIEW_AUTH_ENV.basic]: BASIC },
      "authorization",
      "Set GAUGELINE_BASIC_AUTH to user:password.",
    ],
    [
      "preview-vercel",
      { [PREVIEW_AUTH_ENV.vercel]: BYPASS },
      "x-vercel-protection-bypass",
      "Set GAUGELINE_VERCEL_BYPASS to the project's Protection Bypass for Automation secret.",
    ],
  ] as const) {
    it(`${name}: without the variable, one ConfigError and no findings; with it, the 10-row plan runs`, async () => {
      const site = await startFixture(name);
      try {
        const rows = plan().rows;
        const locked = checkBuilt(rows, {
          base: site.origin,
          fetcher: createFetcher({ allowPrivate: true }),
        });
        await expect(locked).rejects.toThrow(ConfigError);
        await locked.catch((err: ConfigError) => {
          expect(err.message).toMatch(/^Could not check: the preview at .* asked for a password/);
          expect(err.hint).toBe(hint);
        });
        // The probe is the only request: one password page, not ten.
        expect(site.total).toBe(1);

        const auth = previewAuth(env, site.origin);
        if (!auth) throw new Error("expected auth");
        const open = await checkBuilt(rows, {
          base: site.origin,
          fetcher: createFetcher({ allowPrivate: true, headersFor: authHeaders(auth) }),
          auth,
        });
        expect(open.couldNotCheck).toEqual([]);
        expect(open.findings.map((f) => f.checkId)).toEqual([
          "plan-canonical-elsewhere",
          "plan-404",
          "plan-title-drift",
          "plan-h1-drift",
          "plan-anchor-missing",
        ]);
        expect(site.requests.slice(1).every((r) => r.headers[header] !== undefined)).toBe(true);
        expect([...site.methods.keys()]).toEqual(["GET"]);
      } finally {
        await site.close();
      }
    });
  }

  it("a page that redirects to another origin: the second request carries no auth header", async () => {
    const site = await startFixture("preview-basic-auth");
    try {
      const auth = previewAuth({ [PREVIEW_AUTH_ENV.basic]: BASIC }, site.origin);
      if (!auth) throw new Error("expected auth");
      // elsewhere.test is this same server under another name: another origin, no DNS involved.
      const fetcher = createFetcher({
        allowPrivate: true,
        headersFor: authHeaders(auth),
        hosts: { "elsewhere.test": new URL(site.origin).host },
      });
      const hops = await fetcher.get(`${site.origin}/away`);
      expect(hops.map((h) => h.status)).toEqual([302, 401]);
      const [away, landing] = site.requests;
      expect(away?.path).toBe("/away");
      expect(away?.headers.authorization).toBe(`Basic ${b64(BASIC)}`);
      expect(landing?.path).toBe("/landing");
      expect(hops[1]?.url).toMatch(/^http:\/\/elsewhere\.test:\d+\/landing$/);
      expect(landing?.headers.authorization).toBeUndefined();
    } finally {
      await site.close();
    }
  });
});

describe("preview auth: edge cases", () => {
  /** A fetcher answering each path from a table: [status, body, headers]. */
  const fake = (pages: Record<string, [number, string?, Record<string, string>?]>) => ({
    get: async (url: string): Promise<Hop[]> => {
      const [status, body, headers] = pages[new URL(url).pathname] ?? [404, ""];
      return [
        {
          url,
          status,
          headers: { "content-type": "text/html", ...headers },
          body: body ?? "",
          ms: 1,
        },
      ];
    },
    getSite: async () => [],
    stats: { requests: 0, maxInFlight: 0 },
  });
  const row = (line: number, path: string, extra: Partial<PlanRow> = {}): PlanRow => ({
    line,
    url: `https://harbour.example${path}`,
    path,
    raw: {},
    ...extra,
  });

  it("a 403 from a firewall that blocks the user agent: refused, without claiming a password", async () => {
    const err = await checkBuilt([row(2, "/a")], {
      base: BASE,
      fetcher: fake({ "/": [403, "Forbidden: automated access is not allowed."] }),
    }).catch((e: ConfigError) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toBe(
      "Could not check: the preview at https://preview.example refused the request (403). It did not ask for a password; it may block automated readers. Nothing in the plan was checked.",
    );
    expect((err as ConfigError).message).not.toMatch(/asked for a password/);
  });

  it("the probe passes and one page returns 401 (a members area): that row is could-not-check, the others are checked", async () => {
    const out = await checkBuilt(
      [
        row(2, "/", { h1: "Home" }),
        row(3, "/members", { h1: "Members" }),
        row(4, "/shop", { h1: "Shop" }),
      ],
      {
        base: BASE,
        fetcher: fake({
          "/": [200, "<h1>Home</h1>"],
          "/members": [401, "", { "www-authenticate": 'Basic realm="members"' }],
          "/shop": [200, "<h1>Shop now</h1>"],
        }),
      },
    );
    expect(out.couldNotCheck).toEqual([
      { url: `${BASE}/members`, reason: "asked for a password (401)", lines: [3] },
    ]);
    expect(out.findings.map((f) => [f.checkId, f.group?.lines])).toEqual([["plan-h1-drift", [4]]]);
  });

  it("a password with a colon and non-ASCII characters is encoded as UTF-8, split at the first colon", () => {
    const auth = previewAuth({ [PREVIEW_AUTH_ENV.basic]: "töpfer:glaze:ä€" }, BASE);
    expect(auth?.headers.authorization).toBe(`Basic ${b64("töpfer:glaze:ä€")}`);
    expect(
      Buffer.from(auth?.headers.authorization?.slice(6) ?? "", "base64").toString("utf8"),
    ).toBe("töpfer:glaze:ä€");
  });

  it("a 401 with WWW-Authenticate: Bearer does not suggest GAUGELINE_BASIC_AUTH", () => {
    const p = protectionOf(hop(401, "", { "www-authenticate": 'Bearer realm="api"' }));
    expect(p).toEqual({ kind: "password", status: 401, scheme: "Bearer" });
    const err = protectionMessage(p ?? { kind: "refused", status: 0 }, BASE);
    expect(`${err.message} ${err.hint ?? ""}`).not.toContain("GAUGELINE_BASIC_AUTH");
    expect(err.hint).toBe(
      'Set GAUGELINE_PREVIEW_HEADER to the header it expects, for example "Authorization: Bearer ...".',
    );
  });

  it("the Netlify password form says to use basic auth instead", () => {
    const p = protectionOf(hop(200, NETLIFY_FORM));
    const err = protectionMessage(p ?? { kind: "refused", status: 0 }, BASE);
    expect(err.message).toBe(
      "Could not check: the preview at https://preview.example asked for a password (Netlify's password form, which Gaugeline will not post).",
    );
    expect(err.hint).toContain("set GAUGELINE_BASIC_AUTH to user:password");
  });

  it("http with a secret: a warning on 127.0.0.1 and localhost, a ConfigError anywhere else", () => {
    const env = { [PREVIEW_AUTH_ENV.vercel]: BYPASS };
    expect(previewAuth(env, "http://127.0.0.1:4000")?.warning).toBe(
      "Vercel bypass (set) is sent in clear text to http://127.0.0.1:4000 (allowed on this machine only).",
    );
    expect(previewAuth(env, "http://localhost:4000")?.warning).toBeDefined();
    expect(previewAuth(env, BASE)?.warning).toBeUndefined();
    expect(() => previewAuth(env, "http://preview.example")).toThrow(
      "GAUGELINE_VERCEL_BYPASS would be sent in clear text to http://preview.example.",
    );
  });
});
