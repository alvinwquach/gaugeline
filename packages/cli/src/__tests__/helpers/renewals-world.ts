import type { Transport } from "@gaugeline/core";
import {
  recordedTransport,
  type Recorded,
  type Seen,
} from "../../../../core/src/renewals/__tests__/recorded.js";
import { bootstrapFor, COM_DOMAIN } from "../../../../core/src/renewals/__tests__/rdap-fixtures.js";

/**
 * The invented world the renewals docs and tests run in, answered from recorded responses (nothing
 * touches a network). Two clients of one freelancer, on 11 Nov 2026:
 *  - marlowe-bar.com, a bar's site on Vercel: the domain renews in 22 days, the certificate in 3,
 *    www is not on the certificate, a GitHub token expires in 15 days, the Vercel token has no
 *    expiry and the Vercel project builds on Node.js 18.
 *  - cedar-clinic.co.uk, a clinic: the registration ran out nine days ago and the domain is on hold,
 *    so the site does not answer at all.
 */
export const NOW = new Date("2026-11-11T09:00:00Z");

/** Invented keys, built at run time so no key-shaped string sits in the repository. */
export const GITHUB_TOKEN = ["github", "_pat_", "INVENTED", "bar0001"].join("");
export const VERCEL_TOKEN = ["vercel", "-invented-", "token", "bar0002"].join("");
export const ENV = {
  NO_COLOR: "1",
  GAUGELINE_GITHUB_TOKEN: GITHUB_TOKEN,
  GAUGELINE_VERCEL_TOKEN: VERCEL_TOKEN,
};

const registrar = (name: string) => ({
  objectClassName: "entity",
  roles: ["registrar"],
  vcardArray: [
    "vcard",
    [
      ["version", {}, "text", "4.0"],
      ["fn", {}, "text", name],
    ],
  ],
});

function notFound(host: string): Recorded {
  return {
    status: 0,
    fail: Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }),
  };
}

export function world(over: Record<string, Recorded> = {}): { transport: Transport; seen: Seen[] } {
  const barCert = {
    names: ["marlowe-bar.com"],
    validFrom: "2026-08-14T12:00:00.000Z",
    validTo: "2026-11-14T12:00:00.000Z",
    issuer: "Invented Authority",
  };
  const altname = Object.assign(new Error("Hostname/IP does not match certificate's altnames"), {
    code: "ERR_TLS_CERT_ALTNAME_INVALID",
    cert: {
      subjectaltname: "DNS:marlowe-bar.com",
      subject: { CN: "marlowe-bar.com" },
      valid_to: new Date(barCert.validTo).toUTCString(),
    },
  });
  return recordedTransport({
    "GET https://marlowe-bar.com/": {
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<!doctype html><html lang=en><title>Marlowe Bar</title><h1>Marlowe Bar</h1><p>Open Tuesday to Sunday.</p></html>",
      certificate: barCert,
    },
    "HEAD https://marlowe-bar.com/": { status: 200, certificate: barCert },
    "HEAD https://www.marlowe-bar.com/": { status: 0, fail: altname },
    "GET https://data.iana.org/rdap/dns.json": {
      status: 200,
      body: bootstrapFor("https://rdap.registry.example", { com: "/com/v1/", uk: "/uk/v1/" }),
    },
    "GET https://rdap.registry.example/com/v1/domain/marlowe-bar.com": {
      status: 200,
      body: {
        ...COM_DOMAIN,
        status: ["client transfer prohibited"],
        events: [{ eventAction: "expiration", eventDate: "2026-12-03T14:02:11Z" }],
      },
    },
    "GET https://api.github.com/rate_limit": {
      status: 200,
      headers: { "github-authentication-token-expiration": "2026-11-26 00:00:00 UTC" },
      body: {},
    },
    "GET https://api.vercel.com/v5/user/tokens/current": {
      status: 200,
      body: { token: { id: "tok_invented", name: "deploy" } },
    },
    "GET https://api.vercel.com/v9/projects/marlowe-bar-site": {
      status: 200,
      body: { name: "marlowe-bar-site", nodeVersion: "18.x" },
    },
    "GET https://cedar-clinic.co.uk/": notFound("cedar-clinic.co.uk"),
    "GET http://cedar-clinic.co.uk/": notFound("cedar-clinic.co.uk"),
    "HEAD https://cedar-clinic.co.uk/": notFound("cedar-clinic.co.uk"),
    "HEAD https://www.cedar-clinic.co.uk/": notFound("www.cedar-clinic.co.uk"),
    "GET https://rdap.registry.example/uk/v1/domain/cedar-clinic.co.uk": {
      status: 200,
      body: {
        objectClassName: "domain",
        ldhName: "cedar-clinic.co.uk",
        status: ["client hold"],
        events: [{ eventAction: "expiration", eventDate: "2026-11-02T00:00:00Z" }],
        entities: [registrar("Harbour Names Ltd")],
      },
    },
    ...over,
  });
}

/** A gaugeline.renewals.json that names the bar's Vercel project. */
export const BAR_CONFIG = JSON.stringify({ vercel: { projects: ["marlowe-bar-site"] } });
