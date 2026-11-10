/**
 * Which Salesforce MCP server Gaugeline will talk to. Exactly one kind: the hosted read-only
 * objects server (sobject-reads), in production or in a sandbox. Salesforce also hosts servers that
 * can write (sobject-mutations, sobject-all) and others (flows, Data Cloud, Tableau); every one of
 * them is refused here, before a request is made. The address is compared whole, not by prefix, so
 * a longer path, a lookalike host, a port, a query or credentials in the address are all refused.
 */
export const SALESFORCE_MCP_HOST = "api.salesforce.com";

/** Production: https://api.salesforce.com/platform/mcp/v1/platform/sobject-reads */
export const SALESFORCE_READ_ONLY_URL = `https://${SALESFORCE_MCP_HOST}/platform/mcp/v1/platform/sobject-reads`;

/** A sandbox or scratch org: Salesforce inserts "sandbox" after the version. */
export const SALESFORCE_READ_ONLY_SANDBOX_URL = `https://${SALESFORCE_MCP_HOST}/platform/mcp/v1/sandbox/platform/sobject-reads`;

const ALLOWED_PATHS: ReadonlySet<string> = new Set([
  new URL(SALESFORCE_READ_ONLY_URL).pathname,
  new URL(SALESFORCE_READ_ONLY_SANDBOX_URL).pathname,
]);

/** Said when the configured server is anything other than the read-only one. */
export class NotReadOnlyServerError extends Error {
  constructor(reason: string) {
    super(
      `${reason} Gaugeline only connects to Salesforce's read-only objects server (${SALESFORCE_READ_ONLY_URL}), and refused to start.`,
    );
    this.name = "NotReadOnlyServerError";
  }
}

/**
 * The address to connect to, as the URL parser normalises it, or a NotReadOnlyServerError that says
 * what is wrong. Nothing is requested here.
 */
export function readOnlyServerAddress(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new NotReadOnlyServerError("The server address is not a valid address.");
  }
  if (u.protocol !== "https:") throw new NotReadOnlyServerError("The server address is not https.");
  if (u.hostname !== SALESFORCE_MCP_HOST || u.port !== "")
    throw new NotReadOnlyServerError(`The server is not ${SALESFORCE_MCP_HOST}.`);
  if (u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "")
    throw new NotReadOnlyServerError("The server address carries more than a path.");
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/$/, "") : u.pathname;
  if (!ALLOWED_PATHS.has(path))
    throw new NotReadOnlyServerError("That is not the read-only objects server (sobject-reads).");
  return `${u.origin}${path}`;
}

/** True when `readOnlyServerAddress` accepts it. For the config file's validation. */
export function isReadOnlySalesforceServer(raw: string): boolean {
  try {
    readOnlyServerAddress(raw);
    return true;
  } catch {
    return false;
  }
}
