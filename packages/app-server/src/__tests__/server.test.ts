import { request as httpRequest, Agent } from "node:http";
import { createServer, connect, type Server } from "node:net";
import { networkInterfaces } from "node:os";
import { describe, expect, it } from "vitest";
import { createKey, keyMatches } from "../key.js";
import { APP_HOST, pickPort, PortRangeError, startApp } from "../server.js";
import { testClientDir } from "./helpers/client.js";

/** A GET as a browser would send it: to the printed address, localhost included. */
function get(
  url: string,
  agent?: Agent,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; cookie?: string }> {
  return new Promise((resolve, reject) => {
    // Both address families, as a browser tries them: on some Node versions localhost may resolve to ::1
    // first, and the app answers on 127.0.0.1 only.
    const opts = { agent: agent ?? false, autoSelectFamily: true, headers } as Parameters<
      typeof httpRequest
    >[1];
    const req = httpRequest(url, opts, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body,
          ...(res.headers["set-cookie"]?.[0]
            ? { cookie: res.headers["set-cookie"][0].split(";")[0] }
            : {}),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

/** Hold a port on 127.0.0.1, as another program would. */
function hold(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen({ host: APP_HOST, port }, () => resolve(s));
  });
}
const release = (s: Server) => new Promise<void>((r) => s.close(() => r()));

describe("app server: unit", () => {
  it("keyMatches: missing, empty, wrong, right, right length with wrong bytes, 10 KB", () => {
    const key = createKey();
    const flipped = `${key.slice(0, -1)}${key.endsWith("A") ? "B" : "A"}`;
    expect([
      keyMatches(undefined, key),
      keyMatches("", key),
      keyMatches("wrong", key),
      keyMatches(key, key),
      keyMatches(flipped, key),
      keyMatches("k".repeat(10 * 1024), key),
    ]).toEqual([false, false, false, true, false, false]);
  });

  it("createKey: 43 characters of the URL-safe alphabet, 1000 calls give 1000 distinct values", () => {
    const keys = Array.from({ length: 1000 }, createKey);
    for (const k of keys) expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(keys).size).toBe(1000);
  });

  it("the port picker: free, first busy, first three busy, all ten busy", async () => {
    const busy = (taken: number) => {
      const asked: number[] = [];
      const listen = async (p: number) => {
        asked.push(p);
        if (p < 4817 + taken) throw Object.assign(new Error("in use"), { code: "EADDRINUSE" });
      };
      return { asked, listen };
    };
    for (const [taken, want] of [
      [0, 4817],
      [1, 4818],
      [3, 4820],
    ] as const) {
      const b = busy(taken);
      expect(await pickPort(b.listen)).toBe(want);
      expect(b.asked).toEqual(Array.from({ length: taken + 1 }, (_, i) => 4817 + i));
    }
    const all = busy(10);
    await expect(pickPort(all.listen)).rejects.toThrow(
      "Ports 4817 to 4826 are all in use, so the app could not start.",
    );
    expect(all.asked).toHaveLength(10);
  });
});

describe("app server: integration (real sockets)", () => {
  it("no s: 403. A wrong s: 403. The right s: 303 with the session, then 200, at the printed address", async () => {
    const app = await startApp({ clientDir: testClientDir(), port: 4900 });
    try {
      const base = `http://localhost:${app.port}/`;
      expect((await get(base)).status).toBe(403);
      expect((await get(`${base}?s=nope`)).status).toBe(403);
      const link = await get(app.url);
      expect(link.status).toBe(303);
      const ok = await get(base, undefined, { cookie: link.cookie ?? "" });
      expect([ok.status, ok.body]).toEqual([
        200,
        expect.stringContaining("Gaugeline is running on this computer"),
      ]);
      expect((await get(`${base}?s=nope`)).body).not.toContain(
        new URL(app.url).searchParams.get("s"),
      );
    } finally {
      await app.close();
    }
  });

  it("server.address().address is exactly 127.0.0.1", async () => {
    const app = await startApp({ clientDir: testClientDir(), port: 4910 });
    try {
      expect(app.host).toBe("127.0.0.1");
      expect(app.host).toBe(APP_HOST);
    } finally {
      await app.close();
    }
  });

  const lan = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  it.skipIf(!lan)(
    "a connection to this machine's LAN address on the same port is refused",
    async () => {
      const app = await startApp({ clientDir: testClientDir(), port: 4920 });
      try {
        const err = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
          const c = connect({ host: lan as string, port: app.port }, () => {
            c.destroy();
            resolve(undefined);
          });
          c.on("error", (e: NodeJS.ErrnoException) => resolve(e));
        });
        expect(err?.code).toBe("ECONNREFUSED");
      } finally {
        await app.close();
      }
    },
  );

  it("close() resolves with a keep-alive connection open, and the port binds again straight after", async () => {
    const app = await startApp({ clientDir: testClientDir(), port: 4930 });
    const agent = new Agent({ keepAlive: true });
    expect((await get(app.url, agent)).status).toBe(303);
    await app.close();
    const again = await hold(app.port);
    await release(again);
    agent.destroy();
  });

  it("4817 held by another process: the next free port, and that address answers", async () => {
    const held = await hold(4940);
    try {
      const app = await startApp({ clientDir: testClientDir(), port: 4940 });
      try {
        expect(app.port).toBe(4941);
        expect(app.url).toMatch(/^http:\/\/localhost:4941\/\?s=[A-Za-z0-9_-]{43}$/);
        expect((await get(app.url)).status).toBe(303);
      } finally {
        await app.close();
      }
    } finally {
      await release(held);
    }
  });
});

describe("app server: edge cases", () => {
  it("ten busy ports reject with a message naming the range", async () => {
    const held = await Promise.all(Array.from({ length: 10 }, (_, i) => hold(4950 + i)));
    try {
      await expect(startApp({ clientDir: testClientDir(), port: 4950 })).rejects.toBeInstanceOf(
        PortRangeError,
      );
      await expect(startApp({ clientDir: testClientDir(), port: 4950 })).rejects.toThrow(
        "Ports 4950 to 4959 are all in use",
      );
    } finally {
      await Promise.all(held.map(release));
    }
  });

  it("EACCES on listen is reported as it is and never retried on another port", async () => {
    const asked: number[] = [];
    await expect(
      pickPort(async (p) => {
        asked.push(p);
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }),
    ).rejects.toMatchObject({ code: "EACCES" });
    expect(asked).toEqual([4817]);
  });

  it("an aborted signal closes it, and a second close is the same promise", async () => {
    const ac = new AbortController();
    const app = await startApp({ clientDir: testClientDir(), port: 4970, signal: ac.signal });
    ac.abort();
    await app.close();
    await expect(app.close()).resolves.toBeUndefined();
    await release(await hold(4970));
  });
});
