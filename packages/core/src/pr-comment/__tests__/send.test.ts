/**
 * The one module that sends a pull request comment (ACTION-COMMENT; ADR-0005 as amended on 14 Nov 2026). Every
 * test runs against a request function the test hands in: a real client request to a server on a loopback
 * address, or one that never answers. Nothing here reaches GitHub, a DNS server or a real token.
 */
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { Agent as HttpsAgent, globalAgent } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scan } from "../../__tests__/post-scan.js";
import {
  COMMENT_HOST,
  COMMENT_TIMEOUT_MS,
  MAX_COMMENT_CHARS,
  commentUrl,
  createCommentSender,
  type CommentFailure,
  type CommentTarget,
  type NameResolver,
} from "../send.js";
import { hangingRequest, routeTo, startServer } from "./send-helpers.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const TOKEN = "demo-token-A1b2C3d4E5f6G7h8I9j0";
const TARGET: CommentTarget = { owner: "brightside-studio", repo: "site.v2", pullNumber: 12 };
const BODY = "### Gaugeline\n\n1 finding: 1 Fix this first.\n";
const answer = (res: ServerResponse, status: number, body: unknown = {}, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const dir = fileURLToPath(new URL("..", import.meta.url));
const text = readFileSync(join(dir, "send.ts"), "utf8");

/** One call against a fresh server that answers as the handler says; the server's hits come back with the result. */
async function post(
  handler: Parameters<typeof startServer>[0],
  call: { token?: string; target?: CommentTarget; body?: string } = {},
) {
  const s = await startServer(handler);
  const r = routeTo(s.port);
  const result = await createCommentSender({ request: r.request })({
    token: call.token ?? TOKEN,
    target: call.target ?? TARGET,
    body: call.body ?? BODY,
  });
  await s.close();
  return { result, hits: s.hits, seen: r.seen };
}

describe("the request: one POST to the pull request's comments, with the workflow's token", () => {
  it("sends exactly one POST to the right address with the right body shape and headers, and says ok on 201", async () => {
    const { result, hits, seen } = await post((_req, res) => answer(res, 201, { id: 1 }));
    expect(result).toEqual({ ok: true });
    expect(hits).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      method: "POST",
      path: "/repos/brightside-studio/site.v2/issues/12/comments",
    });
    expect(JSON.parse(hits[0]!.body)).toEqual({ body: BODY });
    expect(hits[0]!.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "Gaugeline (pull request comment)",
    });
    expect(seen.map((s) => `${s.options.method} ${s.url.href}`)).toEqual([
      "POST https://api.github.com/repos/brightside-studio/site.v2/issues/12/comments",
    ]);
  });

  it("gives the request its own agent, never the global one that carries Node's env proxy", async () => {
    const { seen } = await post((_req, res) => answer(res, 201));
    expect(seen[0]!.options.agent).toBeInstanceOf(HttpsAgent);
    expect(seen[0]!.options.agent).not.toBe(globalAgent);
  });

  it("never reads the answer: a 201 that echoes the token gives back only ok", async () => {
    const { result } = await post((req, res) =>
      answer(res, 201, { echo: req.headers.authorization, body: "x".repeat(200_000) }),
    );
    expect(result).toEqual({ ok: true });
  });
});

describe("failures: a class, one attempt, never a retry", () => {
  const cases: Array<[number, Record<string, string>, CommentFailure]> = [
    [403, {}, "read-only-token"],
    [403, { "retry-after": "60" }, "rate-limited"],
    [403, { "x-ratelimit-remaining": "0" }, "rate-limited"],
    [429, {}, "rate-limited"],
    [401, {}, "bad-token"],
    [404, {}, "not-found"],
    [410, {}, "not-found"],
    [422, {}, "rejected"],
    [500, {}, "outage"],
    [502, {}, "outage"],
    [503, { "retry-after": "5" }, "outage"],
    [302, { location: "https://evil.example/steal" }, "redirect"],
    [418, {}, "other"],
    [200, {}, "other"],
  ];
  for (const [status, headers, failure] of cases)
    it(`${status}${Object.keys(headers).length ? ` with ${Object.keys(headers).join(", ")}` : ""} is "${failure}", after one request`, async () => {
      const { result, hits, seen } = await post((_req, res) =>
        answer(res, status, "nope", headers),
      );
      expect(result).toEqual({ ok: false, failure });
      // One request made, counted where it is made (a retry would be a second call), and one that arrived.
      expect(seen).toHaveLength(1);
      expect(hits).toHaveLength(1);
    });

  it("never leaks the token or the answer's words, even when GitHub echoes the request", async () => {
    for (const status of [400, 401, 403, 404, 422, 500]) {
      const { result } = await post((req, res, hit) =>
        answer(res, status, { message: req.headers.authorization, echo: hit.body }),
      );
      const shown = JSON.stringify(result);
      expect(shown).not.toContain(TOKEN);
      expect(shown).not.toContain(Buffer.from(TOKEN).toString("base64"));
      expect(shown).not.toContain("Bearer");
    }
  });

  it("a connection that fails is unreachable, and says nothing of the token", async () => {
    const s = await startServer(() => undefined);
    const { request } = routeTo(s.port);
    await s.close();
    const result = await createCommentSender({ request })({
      token: TOKEN,
      target: TARGET,
      body: BODY,
    });
    expect(result).toEqual({ ok: false, failure: "unreachable" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("a request that never answers is stopped at the timeout, and the request is destroyed", async () => {
    vi.useFakeTimers();
    const h = hangingRequest();
    const pending = createCommentSender({ request: h.request })({
      token: TOKEN,
      target: TARGET,
      body: BODY,
    });
    await vi.advanceTimersByTimeAsync(COMMENT_TIMEOUT_MS);
    expect(await pending).toEqual({ ok: false, failure: "unreachable" });
    expect(h.destroyed()).toBe(1);
    expect(h.seen).toHaveLength(1);
  });

  it("a caller cannot ask for a longer timeout than the hard one", async () => {
    vi.useFakeTimers();
    const h = hangingRequest();
    const pending = createCommentSender({ request: h.request, timeoutMs: 10 * COMMENT_TIMEOUT_MS })(
      {
        token: TOKEN,
        target: TARGET,
        body: BODY,
      },
    );
    await vi.advanceTimersByTimeAsync(COMMENT_TIMEOUT_MS);
    expect(await pending).toEqual({ ok: false, failure: "unreachable" });
  });
});

describe("what is refused before anything is sent", () => {
  const sendsNothing = async (call: { token: string; target: CommentTarget; body: string }) => {
    const h = hangingRequest();
    expect(await createCommentSender({ request: h.request })(call)).toEqual({
      ok: false,
      failure: "refused",
    });
    expect(h.seen).toEqual([]);
  };
  const base = { token: TOKEN, target: TARGET, body: BODY };

  it("a target that is not a repository and a pull request number", async () => {
    const bad: CommentTarget[] = [
      { ...TARGET, owner: "../evil" },
      { ...TARGET, owner: "a/b" },
      { ...TARGET, owner: ".." },
      { ...TARGET, repo: ".." },
      { ...TARGET, repo: "." },
      { ...TARGET, owner: "" },
      { ...TARGET, repo: "site#frag" },
      { ...TARGET, repo: "site?x=1" },
      { ...TARGET, repo: `a${"@"}evil.test` },
      { ...TARGET, repo: "a%2f..%2f" },
      { ...TARGET, repo: "a b" },
      { ...TARGET, owner: "o".repeat(101) },
      { ...TARGET, pullNumber: 0 },
      { ...TARGET, pullNumber: -3 },
      { ...TARGET, pullNumber: 1.5 },
      { ...TARGET, pullNumber: Number.NaN },
      { ...TARGET, pullNumber: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const target of bad) await sendsNothing({ ...base, target });
  });

  it("an empty token, a token with a line break, an empty comment and one over the cap", async () => {
    await sendsNothing({ ...base, token: "" });
    await sendsNothing({ ...base, token: `${TOKEN}\r\nHost: evil.example` });
    await sendsNothing({ ...base, body: "" });
    await sendsNothing({ ...base, body: "x".repeat(MAX_COMMENT_CHARS + 1) });
  });

  it("a token with any control character is never sent: the result is other, and holds no token", async () => {
    for (const ch of ["\u0000", "\u0001", "\u001b", "\u001f", "\u007f"]) {
      const token = `${TOKEN}${ch}tail`;
      const { result, hits } = await post((_req, res) => answer(res, 201), { token });
      expect(result, JSON.stringify(ch)).toEqual({ ok: false, failure: "other" });
      expect(JSON.stringify(result)).not.toContain("demo-token");
      expect(hits).toEqual([]);
    }
  });

  it("a comment of exactly the cap is sent", async () => {
    const { result, hits } = await post((_req, res) => answer(res, 201), {
      body: "x".repeat(MAX_COMMENT_CHARS),
    });
    expect(result).toEqual({ ok: true });
    expect(hits).toHaveLength(1);
  });

  it("the address is always api.github.com, for any accepted target", () => {
    expect(commentUrl(TARGET)?.href).toBe(
      "https://api.github.com/repos/brightside-studio/site.v2/issues/12/comments",
    );
    expect(COMMENT_HOST).toBe("api.github.com");
    for (const owner of ["a", "A-b_c.d", "9", "x".repeat(100)])
      expect(commentUrl({ owner, repo: "r", pullNumber: 1 })?.host).toBe("api.github.com");
  });
});

describe("the address rule", () => {
  /** The lookup the sender hands to node:https, called with a name that resolves where the test says. */
  async function lookupFor(address: string | undefined, family = 4) {
    const s = await startServer((_req, res) => answer(res, 201));
    const r = routeTo(s.port);
    const resolve: NameResolver = (_host, _options, cb) =>
      address === undefined ? cb(null, [], family) : cb(null, [{ address, family }], family);
    await createCommentSender({ request: r.request, resolve })({
      token: TOKEN,
      target: TARGET,
      body: BODY,
    });
    await s.close();
    const lookup = r.seen[0]!.options.lookup as unknown as NameResolver;
    return new Promise<{ code?: string; ok: boolean }>((done) =>
      lookup(COMMENT_HOST, {}, (err) =>
        done({ ok: err === null, ...(err?.code ? { code: err.code } : {}) }),
      ),
    );
  }

  it("refuses a name that resolves to a loopback, private, link-local, CGNAT or metadata address", async () => {
    for (const a of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.0.9",
      "172.16.5.5",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
    ])
      expect(await lookupFor(a), a).toEqual({ ok: false, code: "EGAUGELINENOTPUBLIC" });
    for (const a of ["::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"])
      expect(await lookupFor(a, 6), a).toEqual({ ok: false, code: "EGAUGELINENOTPUBLIC" });
    expect(await lookupFor(undefined)).toEqual({ ok: false, code: "EGAUGELINENOTPUBLIC" });
  });

  it("lets a public address through", async () => {
    expect(await lookupFor("140.82.112.5")).toEqual({ ok: true });
  });

  it("reports a refused address as blocked-address", async () => {
    const result = await createCommentSender({
      resolve: (_h, _o, cb) => cb(null, [{ address: "10.0.0.1", family: 4 }], 4),
    })({ token: TOKEN, target: TARGET, body: BODY });
    expect(result).toEqual({ ok: false, failure: "blocked-address" });
  });
});

describe("Node's own proxy support", () => {
  it.each([
    ["NODE_USE_ENV_PROXY=1", [], { NODE_USE_ENV_PROXY: "1" }],
    ["--use-env-proxy", ["--use-env-proxy"], {}],
  ])(
    "does not skip the address rule (%s): the lookup is called and the proxy is never used",
    async (_n, flags, extra) => {
      if (flags.length > 0 && !process.allowedNodeEnvironmentFlags.has("--use-env-proxy")) return;
      // The proxy is here, in the test, and the child is started with the proxy variables already set: Node reads
      // them when it builds its global agents at startup, so setting them later would test nothing.
      const hits: string[] = [];
      const proxy = createServer();
      proxy.on("connect", (req, socket) => {
        hits.push(String(req.url));
        socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      });
      proxy.on("request", (req, res) => {
        hits.push(String(req.url));
        res.writeHead(502).end();
      });
      await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
      const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
      const child = join(dir, "__tests__", "send-proxy-child.mjs");
      try {
        // Whatever proxy this machine has is replaced, so the run is the same here and in CI.
        const env = { ...process.env } as Record<string, string | undefined>;
        for (const k of Object.keys(env))
          if (/^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy)$/i.test(k)) delete env[k];
        const { stdout } = await promisify(execFile)(
          process.execPath,
          [...flags, "--import", "tsx", child],
          {
            cwd: root,
            env: {
              ...env,
              ...extra,
              HTTPS_PROXY: url,
              https_proxy: url,
              HTTP_PROXY: url,
              http_proxy: url,
              NO_PROXY: "",
              no_proxy: "",
            },
            encoding: "utf8",
            timeout: 90_000,
          },
        );
        const last = JSON.parse(stdout.trim().split("\n").pop()!) as {
          ok: boolean;
          failure: string;
          lookups: number;
        };
        expect(last).toMatchObject({ ok: false, failure: "blocked-address" });
        expect(last.lookups).toBeGreaterThan(0);
        expect(hits).toEqual([]);
      } finally {
        await new Promise<void>((r) => proxy.close(() => r()));
      }
    },
    120_000,
  );
});

describe("where this module sits", () => {
  it("builds one POST and no PUT, PATCH or DELETE, and opens a connection through node:https only", () => {
    const found = scan("core/src/pr-comment/send.ts", text);
    expect(found.filter((f) => f.category === "verb")).toHaveLength(1);
    expect(text.match(/method:\s*"POST"/g)).toHaveLength(1);
    expect(text).not.toMatch(/["'`](PUT|PATCH|DELETE|GET|HEAD)["'`]/);
    expect([...text.matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]).sort()).toEqual(
      ["../addresses.js", "node:dns", "node:https", "node:net", "node:stream"].sort(),
    );
    expect(text).not.toMatch(/\bfetch\s*\(|from "(node:)?http"|http:\/\/|process\s*\.\s*env/);
    // Not the Enterprise Server address: the only address in the file is api.github.com, built from the constant.
    expect(text.match(/https?:\/\/[^\s"'`)]+/g)).toEqual(["https://${COMMENT_HOST}${path}"]);
    expect(text).not.toMatch(/GITHUB_API_URL\s*[.[\]]/);
  });

  it("is the only pr-comment entry in the post-boundary list, as one file and for verb and network only", () => {
    const t = readFileSync(join(root, "packages/core/src/__tests__/post-boundary.test.ts"), "utf8");
    const list = t.slice(t.indexOf("const ALLOWED"), t.indexOf("const packagesDir"));
    const entries = [...list.matchAll(/^\s*"([^"]+)":\s*\[([^\]]*)\]/gm)].map((m) => [
      m[1]!,
      m[2]!.replace(/\s/g, ""),
    ]);
    expect(entries.filter(([k]) => k!.includes("pr-comment"))).toEqual([
      ["core/src/pr-comment/send.ts", '"verb","network"'],
    ]);
  });

  it("a second file that sends fails the scan and is not on the list", () => {
    const t = readFileSync(join(root, "packages/core/src/__tests__/post-boundary.test.ts"), "utf8");
    const second = [
      'import { request } from "node:https";',
      'export const send = () => request("https://api.github.com/x", { method: "POST" });',
    ].join("\n");
    const found = scan("core/src/pr-comment/second.ts", second).map((f) => f.category);
    expect(found).toEqual(expect.arrayContaining(["verb", "network"]));
    expect(t).not.toContain("pr-comment/second.ts");
  });

  it("is the only file the lint rule lets import node:https in pr-comment, and still bans node:http, sockets and fetch", async () => {
    const eslint = new ESLint({ cwd: root });
    const rules = async (file: string) => {
      const cfg = await eslint.calculateConfigForFile(
        join(root, "packages/core/src/pr-comment", file),
      );
      const imports = cfg.rules?.["no-restricted-imports"] as [
        unknown,
        { paths: Array<{ name: string }> },
      ];
      return {
        imports: imports[1].paths.map((p) => p.name),
        globals: (cfg.rules?.["no-restricted-globals"] as unknown[])
          .slice(1)
          .map((g) => (g as { name: string }).name),
      };
    };
    for (const file of ["send.ts", "second.ts", "format.ts"]) {
      const { imports, globals } = await rules(file);
      for (const n of ["node:http", "http", "node:net", "node:tls", "tls", "@gaugeline/cli"])
        expect(imports, `${file} ${n}`).toContain(n);
      if (file === "send.ts") expect(imports).not.toContain("node:https");
      else expect(imports, file).toContain("node:https");
      expect(globals, file).toEqual(
        expect.arrayContaining(["fetch", "XMLHttpRequest", "WebSocket", "EventSource"]),
      );
    }
  });

  it("is imported by core's index alone, and nothing else in the repository reaches into it", () => {
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        if (["node_modules", "dist", "__tests__", ".next", ".turbo"].includes(n)) return [];
        const full = join(d, n);
        return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(n) ? [full] : [];
      });
    const files = [...walk(join(root, "packages")), ...walk(join(root, "apps"))].filter(
      (f) => !f.endsWith(join("pr-comment", "send.ts")),
    );
    expect(files.length).toBeGreaterThan(100);
    expect(
      files
        .filter((f) => /pr-comment\/send(\.js)?["']/.test(readFileSync(f, "utf8")))
        .map((f) => f.slice(root.length)),
    ).toEqual([join("packages", "core", "src", "index.ts")]);
  });
});
