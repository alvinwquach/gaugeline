/** Invented RDAP answers, shaped like RFC 9083's domain object. No real registrant, registrar or domain. */

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

/** marlowe-bar.com: one expiration event, one registrar, a hold status. */
export const COM_DOMAIN = {
  objectClassName: "domain",
  ldhName: "MARLOWE-BAR.COM",
  status: ["client transfer prohibited", "client hold"],
  events: [
    { eventAction: "registration", eventDate: "2019-12-03T14:02:11Z" },
    { eventAction: "expiration", eventDate: "2026-12-03T14:02:11Z" },
    { eventAction: "last changed", eventDate: "2025-12-01T09:00:00Z" },
  ],
  entities: [registrar("Plume Registrar, Inc.")],
};

export const DEV_DOMAIN = {
  objectClassName: "domain",
  ldhName: "KILN-COFFEE.DEV",
  status: ["client delete prohibited", "client transfer prohibited"],
  events: [{ eventAction: "expiration", eventDate: "2027-03-09T00:00:00Z" }],
  entities: [registrar("Harbour Names Ltd")],
};

/** A registry that hides its dates: no events at all. */
export const NO_DATES = {
  objectClassName: "domain",
  ldhName: "CEDAR-CLINIC.EXAMPLE",
  status: ["active"],
  events: [{ eventAction: "last changed", eventDate: "2026-01-01T00:00:00Z" }],
  entities: [registrar("Plume Registrar, Inc.")],
};

/** Two expiration events: the earlier is the one that matters. */
export const MANY_EVENTS = {
  objectClassName: "domain",
  ldhName: "BONDI-POP-UP.EXAMPLE",
  events: [
    { eventAction: "expiration", eventDate: "2027-01-01T00:00:00Z" },
    { eventAction: "expiration", eventDate: "2026-11-20T00:00:00Z" },
    { eventAction: "registrar expiration", eventDate: "2026-10-01T00:00:00Z" },
  ],
};

/** The shape of IANA's bootstrap file (RFC 9224): each service is [TLDs, base URLs]. */
export function bootstrapFor(origin: string, tlds: Record<string, string>) {
  return {
    version: "1.0",
    publication: "2026-11-01T00:00:00Z",
    description: "RDAP bootstrap file for Domain Name System registrations (invented fixture)",
    services: Object.entries(tlds).map(([tld, path]) => [[tld], [`${origin}${path}`]]),
  };
}
