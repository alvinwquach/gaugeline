import {
  RECORD_ID,
  CrmUnavailableError,
  isBlank,
  splitFields,
  stripPersonal,
  type CrmCount,
  type CrmField,
  type CrmLead,
  type CrmSample,
  type CrmSource,
} from "./crm.js";
import { readOnlyServerAddress } from "./salesforce-server.js";

export {
  NotReadOnlyServerError,
  SALESFORCE_READ_ONLY_SANDBOX_URL,
  SALESFORCE_READ_ONLY_URL,
  isReadOnlySalesforceServer,
  readOnlyServerAddress,
} from "./salesforce-server.js";

/**
 * Salesforce through its own hosted MCP server (X55). Gaugeline is the MCP client and the server is
 * the read-only objects server; nothing else of Salesforce's is built here. Three rules hold in
 * this file and are tested:
 *
 * - The configured server must be the read-only one, checked whole before anything is sent.
 * - Only two tools are ever called, both reads: `soqlQuery` and `getObjectSchema`. Every query is
 *   built here from a fixed template and a validated field name; text from anywhere else never
 *   becomes part of a query. If the server lists a tool that can change data, the run stops.
 * - A run makes at most MAX_CALLS requests, and stops when Salesforce says the org's API allowance
 *   is nearly used, because each call counts against the customer's quota.
 *
 * The network itself is behind `McpTransport`, so this file never opens a connection and holds no
 * key. The tool names, their arguments and the shape of their answers follow Salesforce's hosted
 * server as described in third-party guides; Salesforce's own page was not reachable when this was
 * written, so they are uncited and the recordings in packages/fixtures/salesforce-mcp are written
 * by hand (see PROGRESS.md, Owner actions).
 */

/** One JSON-RPC 2.0 message to the server. A message with no id is a notification. */
export interface McpMessage {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

/** What came back: the JSON-RPC response body (none for a notification), and the API allowance if the transport saw it. */
export interface McpReply {
  body?: unknown;
  /** Salesforce's allowance as it reports it (the Sforce-Limit-Info header: api-usage=used/max). */
  apiUsage?: { used: number; max: number };
}

/**
 * Sends one message to the given server address and returns its answer. The address is the one
 * this file validated; a transport must use it as given. It throws McpHttpError for a non-2xx answer.
 */
export interface McpTransport {
  send(server: string, message: McpMessage): Promise<McpReply>;
}

/** The server answered with an HTTP status that is not a success. */
export class McpHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`The MCP server answered HTTP ${status}.`);
    this.name = "McpHttpError";
    this.status = status;
  }
}

/** The only tools this client calls. Both read. */
export const SOQL_TOOL = "soqlQuery";
export const SCHEMA_TOOL = "getObjectSchema";
export const READ_TOOLS: readonly string[] = Object.freeze([SOQL_TOOL, SCHEMA_TOOL]);

/** The argument names of the two tools. `query` is as Salesforce documents it; the schema one is uncited. */
const QUERY_ARGUMENT = "query";
const OBJECT_ARGUMENT = "objectName";

/** Requests in one run, counting the handshake. "At most a handful": init, initialized, list, schema, count, sample. */
export const MAX_CALLS = 8;

/** Stop when this much of the org's API allowance is used. */
export const DEFAULT_STOP_AT_PERCENT = 90;

/** The MCP revision this client speaks. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Longest answer text parsed. A lead sample of 200 ids is a few kilobytes. */
const MAX_ANSWER_CHARS = 2_000_000;

/** Verbs that mean a tool can change data. A server that lists one is not the read-only one. */
const WRITE_VERBS: ReadonlySet<string> = new Set([
  "create",
  "update",
  "delete",
  "undelete",
  "upsert",
  "insert",
  "mutate",
  "mutation",
  "write",
  "remove",
  "merge",
  "execute",
  "invoke",
  "post",
  "patch",
  "put",
  "send",
  "submit",
  "assign",
  "convert",
  "approve",
  "deploy",
  "run",
]);

/** The words of a tool name: "createRecord", "delete_record" and "sobject-update" all split. */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");
}

/** The first tool in a list whose name says it can change data, or undefined. */
export function writeCapableTool(names: readonly string[]): string | undefined {
  return names.find((n) => words(n).some((w) => WRITE_VERBS.has(w)));
}

/** A tool name from the server, made safe to print: letters, digits and a few separators, cut short. */
const safeName = (name: string): string => name.replace(/[^A-Za-z0-9_.-]/g, "?").slice(0, 40);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Salesforce error codes Gaugeline recognises in an answer. The rest of the text is never shown. */
const ERROR_CODE =
  /REQUEST_LIMIT_EXCEEDED|API_DISABLED_FOR_ORG|INVALID_SESSION_ID|INSUFFICIENT_ACCESS[A-Z_]*|INVALID_TYPE|INVALID_FIELD|NOT_FOUND|FORBIDDEN|UNAUTHORIZED|API_CURRENTLY_DISABLED/;

const NO_LEAD_ACCESS =
  "The signed-in user cannot read the Lead object, so the CRM was not checked. In Salesforce, give their profile or permission set Read on Leads and on the lead source fields (see docs/sources/salesforce-mcp).";

function errorFrom(text: string): CrmUnavailableError {
  const code = ERROR_CODE.exec(text)?.[0];
  switch (code) {
    case "REQUEST_LIMIT_EXCEEDED":
      return new CrmUnavailableError(
        "quota",
        "Salesforce says the org's API request limit is used up, so the run stopped and the CRM was not checked. Try again after the allowance resets.",
      );
    case "INVALID_SESSION_ID":
    case "UNAUTHORIZED":
      return new CrmUnavailableError(
        "refused",
        "Salesforce did not accept the access token. Get a new one for the External Client App and try again.",
      );
    case "INVALID_FIELD":
      return new CrmUnavailableError(
        "no-access",
        "The signed-in user cannot read one of the lead source fields (or it does not exist), so the CRM was not checked. Check sourceFields in gaugeline.crm.json and field-level security.",
      );
    case "API_DISABLED_FOR_ORG":
    case "API_CURRENTLY_DISABLED":
      return new CrmUnavailableError(
        "refused",
        "This Salesforce org does not allow API access for the signed-in user, so the CRM was not checked.",
      );
    case undefined:
      return new CrmUnavailableError(
        "unreachable",
        "Salesforce answered with an error Gaugeline does not recognise, so the CRM was not checked.",
      );
    default:
      return new CrmUnavailableError("no-access", NO_LEAD_ACCESS);
  }
}

function httpError(status: number): CrmUnavailableError {
  if (status === 401)
    return new CrmUnavailableError(
      "refused",
      "Salesforce did not accept the access token (HTTP 401). Get a new one for the External Client App and try again.",
    );
  if (status === 403)
    return new CrmUnavailableError(
      "no-access",
      "Salesforce refused the signed-in user access to the read-only server (HTTP 403). Check that the External Client App is installed, that the read-only server is activated, and that the user has been given the app.",
    );
  if (status === 429)
    return new CrmUnavailableError(
      "quota",
      "Salesforce asked Gaugeline to slow down (HTTP 429), so the run stopped and the CRM was not checked.",
    );
  return new CrmUnavailableError(
    "unreachable",
    `The Salesforce MCP server answered HTTP ${status}, so the CRM was not checked.`,
  );
}

export interface SalesforceMcpOptions {
  /** The configured server address. Anything but the read-only server throws NotReadOnlyServerError here. */
  server: string;
  transport: McpTransport;
  /** Stop at this percentage of the API allowance used. Default 90. */
  stopAtPercent?: number;
  /** Requests allowed in one run. Default MAX_CALLS. */
  maxCalls?: number;
  /** Sent to the server as the client's version. */
  clientVersion?: string;
}

/** SOQL's datetime literal: UTC, to the second, no quotes. */
const soqlTime = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** Salesforce writes offsets as +0000; Date.parse wants +00:00 in some engines. */
function parseTime(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(ms) ? undefined : new Date(ms);
}

export function salesforceMcpSource(options: SalesforceMcpOptions): CrmSource {
  // Refuses to start: nothing below runs for a server that is not the read-only one.
  const server = readOnlyServerAddress(options.server);
  const { transport } = options;
  const stopAt = options.stopAtPercent ?? DEFAULT_STOP_AT_PERCENT;
  const maxCalls = options.maxCalls ?? MAX_CALLS;
  let calls = 0;
  let nextId = 1;
  let stopped: CrmUnavailableError | undefined;
  let connected: Promise<void> | undefined;

  function noteUsage(usage: McpReply["apiUsage"]): void {
    if (!usage || !(usage.max > 0)) return;
    const percent = Math.floor((usage.used / usage.max) * 100);
    if (percent >= stopAt)
      stopped = new CrmUnavailableError(
        "quota",
        `Salesforce reports ${percent}% of the org's API allowance used (${usage.used} of ${usage.max}), so the run stopped at ${stopAt}% and the CRM was not checked further. Each call counts against the customer's quota.`,
      );
  }

  /** One request. Counts against the call limit; stops everything once the allowance is nearly used. */
  async function send(message: McpMessage): Promise<unknown> {
    if (stopped) throw stopped;
    if (calls >= maxCalls)
      throw new CrmUnavailableError(
        "limit",
        `Gaugeline makes at most ${maxCalls} requests to the CRM in one run and has made them, so the rest was not checked.`,
      );
    calls += 1;
    let reply: McpReply;
    try {
      reply = await transport.send(server, message);
    } catch (err) {
      if (err instanceof McpHttpError) throw httpError(err.status);
      if (err instanceof CrmUnavailableError) throw err;
      throw new CrmUnavailableError(
        "unreachable",
        "Salesforce's MCP server did not answer, so the CRM was not checked.",
      );
    }
    noteUsage(reply.apiUsage);
    if (message.id === undefined) return undefined;
    const body = reply.body;
    if (!isObject(body) || body.jsonrpc !== "2.0")
      throw new CrmUnavailableError(
        "unreachable",
        "Salesforce's MCP server answered with something that is not a JSON-RPC response, so the CRM was not checked.",
      );
    if (isObject(body.error)) {
      const text = typeof body.error.message === "string" ? body.error.message : "";
      throw errorFrom(`${text} ${typeof body.error.code === "string" ? body.error.code : ""}`);
    }
    return body.result;
  }

  const request = (method: string, params?: Record<string, unknown>): Promise<unknown> =>
    send({ jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) });

  /** initialize, initialized, tools/list; then the read-only checks on what the server offers. */
  function connect(): Promise<void> {
    connected ??= (async () => {
      await request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "gaugeline", version: options.clientVersion ?? "dev" },
      });
      await send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const listed = await request("tools/list");
      const names =
        isObject(listed) && Array.isArray(listed.tools)
          ? listed.tools.flatMap((t) => (isObject(t) && typeof t.name === "string" ? [t.name] : []))
          : [];
      const writer = writeCapableTool(names);
      if (writer !== undefined)
        throw new CrmUnavailableError(
          "refused",
          `The server offers a tool that can change data (${safeName(writer)}), so it is not the read-only server and Gaugeline did not use it.`,
        );
      const missing = READ_TOOLS.filter((t) => !names.includes(t));
      if (missing.length > 0)
        throw new CrmUnavailableError(
          "refused",
          `The server does not offer ${missing.join(" and ")}, so it is not the read-only objects server Gaugeline expects.`,
        );
    })();
    return connected;
  }

  /** The one place a tool is called. A tool outside READ_TOOLS never reaches the transport. */
  async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!READ_TOOLS.includes(name))
      throw new CrmUnavailableError(
        "refused",
        `Gaugeline does not call the tool ${safeName(name)}.`,
      );
    await connect();
    const result = await request("tools/call", { name, arguments: args });
    if (!isObject(result))
      throw new CrmUnavailableError("unreachable", "Salesforce answered a tool call with nothing.");
    const text = Array.isArray(result.content)
      ? result.content.flatMap((c) =>
          isObject(c) && c.type === "text" && typeof c.text === "string" ? [c.text] : [],
        )[0]
      : undefined;
    if (result.isError === true) throw errorFrom(text ?? "");
    if (isObject(result.structuredContent)) return result.structuredContent;
    if (text === undefined || text.length > MAX_ANSWER_CHARS)
      throw new CrmUnavailableError("unreachable", "Salesforce's answer was empty or too large.");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw errorFrom(text);
    }
  }

  /** A SOQL query, as a SELECT built in this file. The statement is checked once more on its way out. */
  async function soql(statement: string): Promise<Record<string, unknown>[]> {
    if (!/^SELECT\s/.test(statement) || statement.includes(";"))
      throw new CrmUnavailableError("refused", "Gaugeline only sends a single SELECT.");
    const payload = await callTool(SOQL_TOOL, { [QUERY_ARGUMENT]: statement });
    const records =
      isObject(payload) && Array.isArray(payload.records) ? payload.records : undefined;
    if (!records)
      throw new CrmUnavailableError(
        "unreachable",
        "Salesforce's answer to a query had no records.",
      );
    return records.filter(isObject);
  }

  return {
    label: "Salesforce",

    async describeFields(): Promise<CrmField[]> {
      const payload = await callTool(SCHEMA_TOOL, { [OBJECT_ARGUMENT]: "Lead" });
      const fields =
        isObject(payload) && Array.isArray(payload.fields) ? payload.fields : undefined;
      if (!fields)
        throw new CrmUnavailableError(
          "unreachable",
          "Salesforce's answer to the Lead schema had no fields.",
        );
      return fields.flatMap((f): CrmField[] =>
        isObject(f) && typeof f.name === "string"
          ? [{ name: f.name, ...(typeof f.label === "string" ? { label: f.label } : {}) }]
          : [],
      );
    },

    async countLeads(since: Date): Promise<CrmCount> {
      const rows = await soql(
        `SELECT COUNT(Id) n, MAX(CreatedDate) newest FROM Lead WHERE CreatedDate >= ${soqlTime(since)}`,
      );
      const row = rows[0] ?? {};
      const total = typeof row.n === "number" && Number.isFinite(row.n) ? row.n : 0;
      const latest = parseTime(row.newest);
      return { total, ...(latest ? { latest } : {}) };
    },

    async sampleLeads(since: Date, fields: readonly string[], limit = 200): Promise<CrmSample> {
      const { allowed, refused } = splitFields(fields);
      if (allowed.length === 0) return { fields: allowed, refused, leads: [], truncated: false };
      const cap = Math.min(200, Math.max(1, Math.floor(limit)));
      const rows = await soql(
        `SELECT Id, ${allowed.join(", ")} FROM Lead WHERE CreatedDate >= ${soqlTime(since)} ORDER BY CreatedDate DESC LIMIT ${cap}`,
      );
      const leads: CrmLead[] = [];
      for (const row of rows) {
        const id = row.Id;
        if (typeof id !== "string" || !RECORD_ID.test(id)) continue;
        // Whatever else the server sent back is dropped before anything is read from the record.
        const kept = stripPersonal(row);
        const byLower = new Map(Object.entries(kept).map(([k, v]) => [k.toLowerCase(), v]));
        leads.push({ id, blank: allowed.filter((f) => isBlank(byLower.get(f.toLowerCase()))) });
      }
      return { fields: allowed, refused, leads, truncated: rows.length >= cap };
    },
  };
}
