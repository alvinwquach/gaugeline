import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFetcher } from "../../fetcher.js";
import { certificateHosts, coversHost, names, readCertificates } from "../certs.js";

describe("certificateHosts: unit", () => {
  it("reads the bare domain and its www for a site on its own domain", () => {
    expect(certificateHosts("marlowe-bar.com")).toEqual(["marlowe-bar.com", "www.marlowe-bar.com"]);
    expect(certificateHosts("WWW.Marlowe-Bar.com")).toEqual([
      "marlowe-bar.com",
      "www.marlowe-bar.com",
    ]);
    expect(certificateHosts("www.cedar-clinic.co.uk")).toEqual([
      "cedar-clinic.co.uk",
      "www.cedar-clinic.co.uk",
    ]);
  });

  it("reads just the host for a subdomain, a platform address or nothing for an IP", () => {
    expect(certificateHosts("book.marlowe-bar.com")).toEqual(["book.marlowe-bar.com"]);
    expect(certificateHosts("kiln-pop-up.vercel.app")).toEqual(["kiln-pop-up.vercel.app"]);
    expect(certificateHosts("127.0.0.1")).toEqual([]);
  });

  it("knows what a read names", () => {
    const cert = {
      names: ["marlowe-bar.com", "*.shop.marlowe-bar.com"],
      validFrom: "",
      validTo: "",
    };
    expect(names({ host: "marlowe-bar.com", kind: "cert", cert })).toEqual(cert.names);
    expect(names({ host: "x", kind: "name-mismatch", names: ["a.example"] })).toEqual([
      "a.example",
    ]);
    expect(names({ host: "x", kind: "absent" })).toEqual([]);
    expect(coversHost({ host: "a.shop.marlowe-bar.com", kind: "cert", cert })).toBe(true);
    expect(coversHost({ host: "www.marlowe-bar.com", kind: "cert", cert })).toBe(false);
  });
});

const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// A local https server with a certificate made for this run: 5 days left, naming the bare domain only.
describe.skipIf(!hasOpenssl)(
  "readCertificates: integration (a real TLS handshake, a local server)",
  () => {
    let dir = "";
    let ca = "";
    let server: Server;
    let port = 0;

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), "gaugeline-renewals-tls-"));
      const o = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
      o(
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        "ca.key",
        "-out",
        "ca.pem",
        "-days",
        "30",
        "-subj",
        "/CN=Gaugeline Test CA",
      );
      o(
        "req",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        "leaf.key",
        "-out",
        "leaf.csr",
        "-subj",
        "/CN=marlowe-bar.test",
      );
      writeFileSync(join(dir, "ext.cnf"), "subjectAltName=DNS:marlowe-bar.test\n");
      o(
        "x509",
        "-req",
        "-in",
        "leaf.csr",
        "-CA",
        "ca.pem",
        "-CAkey",
        "ca.key",
        "-CAcreateserial",
        "-out",
        "leaf.pem",
        "-days",
        "5",
        "-extfile",
        "ext.cnf",
      );
      ca = readFileSync(join(dir, "ca.pem"), "utf8");
      server = createServer(
        { key: readFileSync(join(dir, "leaf.key")), cert: readFileSync(join(dir, "leaf.pem")) },
        (_req, res) =>
          void res.writeHead(200, { "content-type": "text/html" }).end("<p>Marlowe</p>"),
      );
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      port = (server.address() as AddressInfo).port;
    }, 30_000);

    afterAll(async () => {
      await new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      });
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    const fetcherFor = (gone: string[] = []) =>
      createFetcher({
        ca,
        allowPrivate: true,
        timeoutMs: 5000,
        resolver: async (host) => {
          if (gone.includes(host))
            throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
          return [{ address: "127.0.0.1", family: 4 }];
        },
      });

    it("reads a certificate expiring in 5 days, and a www it does not name", async () => {
      const [apex, www] = await readCertificates(
        ["marlowe-bar.test", "www.marlowe-bar.test"],
        fetcherFor(),
        port,
      );
      expect(apex?.kind).toBe("cert");
      if (apex?.kind === "cert") {
        expect(apex.cert.names).toEqual(["marlowe-bar.test"]);
        const days = (Date.parse(apex.cert.validTo) - Date.now()) / 86_400_000;
        expect(days).toBeGreaterThan(4);
        expect(days).toBeLessThanOrEqual(5);
      }
      expect(www).toMatchObject({
        host: "www.marlowe-bar.test",
        kind: "name-mismatch",
        names: ["marlowe-bar.test"],
      });
      if (www?.kind === "name-mismatch") expect(www.validTo).toBeDefined();
    });

    it("treats a www that is not in DNS as absent, not as a mismatch", async () => {
      const [apex, www] = await readCertificates(
        ["marlowe-bar.test", "www.marlowe-bar.test"],
        fetcherFor(["www.marlowe-bar.test"]),
        port,
      );
      expect(apex?.kind).toBe("cert");
      expect(www).toEqual({ host: "www.marlowe-bar.test", kind: "absent" });
    });

    it("says why a certificate that is not trusted could not be read", async () => {
      const untrusting = createFetcher({
        allowPrivate: true,
        timeoutMs: 5000,
        resolver: async () => [{ address: "127.0.0.1", family: 4 }],
      });
      const [read] = await readCertificates(["marlowe-bar.test"], untrusting, port);
      expect(read?.kind).toBe("unreadable");
      expect(read?.kind === "unreadable" && read.reason).toMatch(
        /marlowe-bar\.test's certificate could not be verified/,
      );
    });
  },
);
