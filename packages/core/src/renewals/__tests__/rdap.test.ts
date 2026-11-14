import { afterEach, describe, expect, it } from "vitest";
import { startServer, type FixtureServer, type Handler } from "../../__tests__/helpers/server.js";
import { createFetcher } from "../../fetcher.js";
import { createRdapClient, isHold, parseRdapDomain } from "../rdap.js";
import { COM_DOMAIN, DEV_DOMAIN, MANY_EVENTS, NO_DATES, bootstrapFor } from "./rdap-fixtures.js";

describe("parseRdapDomain: unit", () => {
  it("reads the expiration event, the registrar name and the statuses", () => {
    expect(parseRdapDomain(COM_DOMAIN)).toEqual({
      expiresAt: "2026-12-03T14:02:11.000Z",
      registrar: "Plume Registrar, Inc.",
      statuses: ["client transfer prohibited", "client hold"],
      expirationEvents: 1,
    });
  });

  it("has no expiry when the registry sends no expiration event", () => {
    const parsed = parseRdapDomain(NO_DATES);
    expect(parsed?.expiresAt).toBeUndefined();
    expect(parsed?.expirationEvents).toBe(0);
    expect(parsed?.registrar).toBe("Plume Registrar, Inc.");
  });

  it("takes the earliest of several expiration events and ignores other event kinds", () => {
    const parsed = parseRdapDomain(MANY_EVENTS);
    expect(parsed?.expiresAt).toBe("2026-11-20T00:00:00.000Z");
    expect(parsed?.expirationEvents).toBe(2);
  });

  it("ignores an expiration event with a date that is not a date", () => {
    const parsed = parseRdapDomain({
      objectClassName: "domain",
      events: [{ eventAction: "expiration", eventDate: "soon" }],
    });
    expect(parsed?.expiresAt).toBeUndefined();
  });

  it("is not a domain when the answer is not an RDAP domain object", () => {
    expect(parseRdapDomain(null)).toBeUndefined();
    expect(parseRdapDomain([])).toBeUndefined();
    expect(parseRdapDomain({ objectClassName: "nameserver" })).toBeUndefined();
    expect(parseRdapDomain({ errorCode: 404, title: "Not Found" })).toBeUndefined();
  });

  it("reads hold statuses however the registry spells them", () => {
    for (const s of ["client hold", "clientHold", "server hold", "ServerHold", "server-hold"])
      expect(isHold(s)).toBe(true);
    for (const s of ["client transfer prohibited", "active", "ok", "pending delete"])
      expect(isHold(s)).toBe(false);
  });
});

describe("createRdapClient: integration (recorded responses on a local server)", () => {
  let server: FixtureServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function serve(
    routes: Record<string, Handler>,
    tlds: Record<string, string> = { com: "/rdap-com/", dev: "/rdap-dev/" },
  ) {
    const holder: { origin: string } = { origin: "" };
    server = await startServer({
      "/dns.json": (_req, res) => {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(bootstrapFor(holder.origin, tlds)));
      },
      ...routes,
    });
    holder.origin = server.origin;
    return createRdapClient({
      fetcher: createFetcher({ allowPrivate: true, timeoutMs: 3000 }),
      bootstrapUrl: `${server.origin}/dns.json`,
    });
  }
  const json =
    (body: unknown, status = 200, headers: Record<string, string> = {}): Handler =>
    (_req, res) => {
      res
        .writeHead(status, { "content-type": "application/rdap+json", ...headers })
        .end(JSON.stringify(body));
    };

  it("finds .com in the bootstrap file and reads the registry's answer", async () => {
    const rdap = await serve({ "/rdap-com/domain/marlowe-bar.com": json(COM_DOMAIN) });
    const read = await rdap.lookup("marlowe-bar.com", "com");
    expect(read).toEqual({
      ok: true,
      domain: "marlowe-bar.com",
      registration: {
        expiresAt: "2026-12-03T14:02:11.000Z",
        registrar: "Plume Registrar, Inc.",
        statuses: ["client transfer prohibited", "client hold"],
      },
    });
    const sent = server?.log.map((r) => `${r.method} ${r.path}`);
    expect(sent).toEqual(["GET /dns.json", "GET /rdap-com/domain/marlowe-bar.com"]);
    expect(server?.log[1]?.headers.accept).toBe("application/rdap+json");
  });

  it("reads .dev from its own registry and asks the bootstrap file once for both", async () => {
    const rdap = await serve({
      "/rdap-com/domain/marlowe-bar.com": json(COM_DOMAIN),
      "/rdap-dev/domain/kiln-coffee.dev": json(DEV_DOMAIN),
    });
    await rdap.lookup("marlowe-bar.com", "com");
    const dev = await rdap.lookup("kiln-coffee.dev", "dev");
    expect(dev.ok && dev.registration.expiresAt).toBe("2027-03-09T00:00:00.000Z");
    expect(server?.log.filter((r) => r.path === "/dns.json")).toHaveLength(1);
  });

  it("is could-not-check for a ccTLD the bootstrap file does not list (no RDAP, never WHOIS)", async () => {
    const rdap = await serve({});
    const read = await rdap.lookup("bondi-pop-up.xx", "xx");
    expect(read).toEqual({
      ok: false,
      domain: "bondi-pop-up.xx",
      reason: expect.stringMatching(/\.xx has no RDAP service/),
    });
    expect(server?.log.map((r) => r.path)).toEqual(["/dns.json"]);
  });

  it("says when to try again after a 429", async () => {
    const rdap = await serve({
      "/rdap-com/domain/marlowe-bar.com": json({ errorCode: 429 }, 429, { "retry-after": "120" }),
    });
    const read = await rdap.lookup("marlowe-bar.com", "com");
    expect(read.ok).toBe(false);
    expect(!read.ok && read.reason).toMatch(/rate limit.*HTTP 429.*Try again in 120 seconds/);
  });

  it("says so when a 429 has no Retry-After", async () => {
    const rdap = await serve({
      "/rdap-com/domain/marlowe-bar.com": json({ errorCode: 429 }, 429),
    });
    const read = await rdap.lookup("marlowe-bar.com", "com");
    expect(!read.ok && read.reason).toMatch(/did not say when to try again/);
  });

  it("is could-not-check when the registry has no such domain, naming the way out", async () => {
    const rdap = await serve({
      "/rdap-com/domain/marlowe-bar.com": json({ errorCode: 404 }, 404),
    });
    const read = await rdap.lookup("marlowe-bar.com", "com");
    expect(!read.ok && read.reason).toMatch(/no record of marlowe-bar\.com \(HTTP 404\).*"domain"/);
  });

  it("is could-not-check on a registry outage", async () => {
    const rdap = await serve({
      "/rdap-com/domain/marlowe-bar.com": (_req, res) => void res.writeHead(503).end("down"),
    });
    const read = await rdap.lookup("marlowe-bar.com", "com");
    expect(!read.ok && read.reason).toMatch(/answered HTTP 503/);
  });

  it("is could-not-check when the bootstrap file cannot be read", async () => {
    const rdap = await serve({});
    await server?.close();
    server = undefined;
    const read = await rdap.lookup("marlowe-bar.com", "com");
    expect(!read.ok && read.reason).toMatch(/IANA's RDAP bootstrap file could not be read/);
  });

  it("is could-not-check when the answer is not RDAP", async () => {
    const rdap = await serve({
      "/rdap-com/domain/marlowe-bar.com": (_req, res) =>
        void res.writeHead(200, { "content-type": "text/html" }).end("<p>Domain lookup</p>"),
    });
    const read = await rdap.lookup("marlowe-bar.com", "com");
    expect(!read.ok && read.reason).toMatch(/not RDAP/);
  });

  it("keeps a registry that hides its dates: no expiry, the statuses still read", async () => {
    const rdap = await serve({ "/rdap-com/domain/marlowe-bar.com": json(NO_DATES) });
    const read = await rdap.lookup("marlowe-bar.com", "com");
    expect(read.ok).toBe(true);
    expect(read.ok && read.registration.expiresAt).toBeUndefined();
    expect(read.ok && read.registration.statuses).toEqual(["active"]);
  });

  it("never sends anything but GET", async () => {
    const rdap = await serve({ "/rdap-com/domain/marlowe-bar.com": json(COM_DOMAIN) });
    await rdap.lookup("marlowe-bar.com", "com");
    expect(new Set(server?.log.map((r) => r.method))).toEqual(new Set(["GET"]));
  });
});
