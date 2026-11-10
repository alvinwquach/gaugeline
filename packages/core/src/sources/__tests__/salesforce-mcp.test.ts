import { describe, expect, it } from "vitest";
import { replayMcp, readMcpRecording } from "../../../../testkit/src/index.js";
import { CrmUnavailableError } from "../crm.js";
import { readCrm, type CrmSettings } from "../crm-read.js";
import { crmConfigSchema } from "../crm.js";
import {
  McpHttpError,
  MAX_CALLS,
  NotReadOnlyServerError,
  READ_TOOLS,
  SALESFORCE_READ_ONLY_SANDBOX_URL,
  SALESFORCE_READ_ONLY_URL,
  readOnlyServerAddress,
  salesforceMcpSource,
  writeCapableTool,
  type McpTransport,
} from "../salesforce-mcp.js";

const NOW = new Date("2026-11-10T18:00:00Z");
const SINCE = new Date("2026-11-03T18:00:00Z");

const settings = (
  transport: McpTransport,
  salesforce: Record<string, unknown> = {},
): CrmSettings => ({ config: crmConfigSchema.parse({ salesforce }), transport });

describe("salesforce-mcp: refuses any server but the read-only one", () => {
  const refused = [
    [
      "the server that can write",
      "https://api.salesforce.com/platform/mcp/v1/platform/sobject-mutations",
    ],
    [
      "the server that reads and writes",
      "https://api.salesforce.com/platform/mcp/v1/platform/sobject-all",
    ],
    [
      "a flows server",
      "https://api.salesforce.com/platform/mcp/v1/platform/salesforce-api-context",
    ],
    ["a longer path", "https://api.salesforce.com/platform/mcp/v1/platform/sobject-reads/extra"],
    [
      "a path that only starts the same",
      "https://api.salesforce.com/platform/mcp/v1/platform/sobject-reads-all",
    ],
    ["a different host", "https://api.salesforce.example/platform/mcp/v1/platform/sobject-reads"],
    [
      "a lookalike host",
      "https://api.salesforce.com.attacker.example/platform/mcp/v1/platform/sobject-reads",
    ],
    [
      "credentials in the address",
      [
        "https://api.salesforce.com",
        "attacker.example/platform/mcp/v1/platform/sobject-reads",
      ].join("@"),
    ],
    [
      "a user name",
      ["https://user:pw", "api.salesforce.com/platform/mcp/v1/platform/sobject-reads"].join("@"),
    ],
    ["a port", "https://api.salesforce.com:8443/platform/mcp/v1/platform/sobject-reads"],
    [
      "a query",
      "https://api.salesforce.com/platform/mcp/v1/platform/sobject-reads?server=sobject-all",
    ],
    ["a fragment", "https://api.salesforce.com/platform/mcp/v1/platform/sobject-reads#x"],
    ["plain http", "http://api.salesforce.com/platform/mcp/v1/platform/sobject-reads"],
    ["upper case in the path", "https://api.salesforce.com/platform/mcp/v1/platform/SObject-Reads"],
    ["an encoded dash", "https://api.salesforce.com/platform/mcp/v1/platform/sobject%2Dreads"],
    ["not an address", "sobject-reads"],
    ["an empty string", ""],
  ] as const;

  it.each(refused)("refuses %s", (_what, server) => {
    const transport = replayMcp("tideline-leads");
    expect(() => salesforceMcpSource({ server, transport })).toThrow(NotReadOnlyServerError);
    // Refused before anything is sent.
    expect(transport.seen).toEqual([]);
  });

  it("says what it refused and what it will use", () => {
    expect(() =>
      readOnlyServerAddress("https://api.salesforce.com/platform/mcp/v1/platform/sobject-all"),
    ).toThrow(/read-only objects server.*refused to start/s);
  });

  it("accepts the production and the sandbox read-only server, with or without a trailing slash", () => {
    expect(readOnlyServerAddress(SALESFORCE_READ_ONLY_URL)).toBe(SALESFORCE_READ_ONLY_URL);
    expect(readOnlyServerAddress(`${SALESFORCE_READ_ONLY_URL}/`)).toBe(SALESFORCE_READ_ONLY_URL);
    expect(readOnlyServerAddress(SALESFORCE_READ_ONLY_SANDBOX_URL)).toBe(
      SALESFORCE_READ_ONLY_SANDBOX_URL,
    );
  });

  it("normalises the address before using it: a dot segment cannot reach another server", () => {
    const via = "https://api.salesforce.com/platform/mcp/v1/platform/sobject-all/../sobject-reads";
    expect(readOnlyServerAddress(via)).toBe(SALESFORCE_READ_ONLY_URL);
    expect(() =>
      readOnlyServerAddress(
        "https://api.salesforce.com/platform/mcp/v1/platform/sobject-reads/../sobject-all",
      ),
    ).toThrow(NotReadOnlyServerError);
  });

  it("through readCrm, a write-capable address is a reason the CRM was not checked, with nothing sent", async () => {
    const transport = replayMcp("tideline-leads");
    const bad: CrmSettings = {
      config: {
        salesforce: {
          server: "https://api.salesforce.com/platform/mcp/v1/platform/sobject-all",
          sourceFields: ["LeadSource"],
          windowDays: 7,
          quietDays: 3,
        },
      },
      transport,
    };
    const read = await readCrm(bad, NOW);
    expect(read.reasons.recent).toMatch(/refused to start/);
    expect(read.recent).toBeUndefined();
    expect(transport.seen).toEqual([]);
  });
});

describe("salesforce-mcp: tools that can change data", () => {
  it("recognises a write-capable tool by the verbs in its name", () => {
    for (const name of [
      "createRecord",
      "update_record",
      "delete-record",
      "upsertSObject",
      "sobject_mutation",
      "executeFlow",
      "runApex",
    ])
      expect(writeCapableTool([name]), name).toBe(name);
    expect(
      writeCapableTool([
        "getObjectSchema",
        "soqlQuery",
        "find",
        "getUserInfo",
        "listRecentSobjectRecords",
        "getRelatedRecords",
      ]),
    ).toBeUndefined();
  });

  it("stops when the right address lists a tool that can write, and calls nothing", async () => {
    const transport = replayMcp("tideline-write-server");
    const source = salesforceMcpSource({ server: SALESFORCE_READ_ONLY_URL, transport });
    await expect(source.describeFields()).rejects.toThrow(
      /offers a tool that can change data \(createRecord\)/,
    );
    expect(transport.seen.map((s) => s.message.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
  });

  it("calls only the two read tools, with a single SELECT each", async () => {
    const transport = replayMcp("tideline-leads");
    const read = await readCrm(settings(transport), NOW);
    expect(read.recent).toBeDefined();
    const calls = transport.seen.filter((s) => s.message.method === "tools/call");
    expect(calls.length).toBe(3);
    for (const c of calls) {
      expect(READ_TOOLS).toContain(c.message.params?.name);
      const query = (c.message.params?.arguments as { query?: string } | undefined)?.query;
      if (query !== undefined) {
        expect(query).toMatch(/^SELECT /);
        expect(query).not.toContain(";");
      }
    }
    // Every request went to the validated read-only address, and nothing but the protocol's own methods was sent.
    expect(new Set(transport.seen.map((s) => s.server))).toEqual(
      new Set([SALESFORCE_READ_ONLY_URL]),
    );
    expect(new Set(transport.seen.map((s) => s.message.method))).toEqual(
      new Set(["initialize", "notifications/initialized", "tools/list", "tools/call"]),
    );
  });

  it("builds queries from fixed templates: a hostile field name never reaches one", async () => {
    const transport = replayMcp("tideline-leads");
    const source = salesforceMcpSource({ server: SALESFORCE_READ_ONLY_URL, transport });
    const sample = await source.sampleLeads(SINCE, [
      "LeadSource; DELETE FROM Lead",
      "Email",
      "FirstName",
    ]);
    expect(sample.leads).toEqual([]);
    expect(sample.refused).toHaveLength(3);
    // Nothing was asked for, so nothing was sent.
    expect(transport.seen).toEqual([]);
  });
});

describe("salesforce-mcp: against recorded responses", () => {
  it("finds 12 of 40 recent leads with a blank source, with the field name and five record ids", async () => {
    const transport = replayMcp("tideline-leads");
    const read = await readCrm(settings(transport), NOW);
    const sample = read.recent?.sample;
    expect(sample?.fields).toEqual(["LeadSource"]);
    expect(sample?.leads).toHaveLength(40);
    const blank = sample?.leads.filter((l) => l.blank.length > 0) ?? [];
    expect(blank).toHaveLength(12);
    expect(blank.slice(0, 5).map((l) => l.id)).toEqual([
      "00Q5e00000Tx002",
      "00Q5e00000Tx003",
      "00Q5e00000Tx007",
      "00Q5e00000Tx009",
      "00Q5e00000Tx012",
    ]);
    expect(read.recent?.since.toISOString()).toBe("2026-11-03T18:00:00.000Z");
    expect(read.window?.count).toEqual({ total: 88, latest: new Date("2026-11-10T16:41:07Z") });
    expect(read.fields?.map((f) => f.name)).toContain("Preferred_Session__c");
    expect(transport.unused()).toEqual([]);
  });

  it("makes a handful of requests: initialize, initialized, list, schema, sample, count", async () => {
    const transport = replayMcp("tideline-leads");
    await readCrm(settings(transport), NOW);
    expect(transport.seen).toHaveLength(6);
    expect(transport.seen.length).toBeLessThanOrEqual(MAX_CALLS);
  });

  it("keeps no name, email, phone or note even when the server sends them", async () => {
    const transport = replayMcp("tideline-leaky");
    const read = await readCrm(settings(transport), NOW);
    expect(read.recent?.sample.leads.filter((l) => l.blank.length > 0)).toHaveLength(4);
    const everything = JSON.stringify(read);
    for (const secret of [
      "Rowan",
      "Ellery",
      "Okafor",
      "Lindqvist",
      "Vance",
      "invented.example",
      "555-01",
      "knee rehab",
      "@",
    ])
      expect(everything, secret).not.toContain(secret);
  });

  it("reads a custom field that holds the campaign", async () => {
    const transport = replayMcp("tideline-custom-field");
    const read = await readCrm(settings(transport, { sourceFields: ["Campaign_Source__c"] }), NOW);
    expect(read.recent?.sample.fields).toEqual(["Campaign_Source__c"]);
    expect(read.recent?.sample.leads.filter((l) => l.blank.length > 0)).toHaveLength(9);
    const query = transport.seen.find((s) =>
      (s.message.params?.arguments as { query?: string } | undefined)?.query?.includes(
        "Campaign_Source__c",
      ),
    );
    expect(query).toBeDefined();
  });

  it("matches the field name without case, and says which named field Lead does not have", async () => {
    const transport = replayMcp("tideline-custom-field");
    const read = await readCrm(
      settings(transport, { sourceFields: ["campaign_source__c", "Not_There__c"] }),
      NOW,
    );
    expect(read.recent?.missingFields).toEqual(["Not_There__c"]);
    expect(read.recent?.sample.fields).toEqual(["Campaign_Source__c"]);
  });

  it("when Lead has none of the named fields, says so and still counts the leads", async () => {
    const transport = replayMcp("tideline-quiet");
    const read = await readCrm(settings(transport, { sourceFields: ["Nope__c"] }), NOW);
    expect(read.recent).toBeUndefined();
    expect(read.reasons.recent).toMatch(/no field called Nope__c/);
    expect(read.window?.count.total).toBe(31);
  });

  it("the signed-in user cannot read Lead: every part is unchecked, with the reason", async () => {
    const transport = replayMcp("tideline-no-lead-access");
    const read = await readCrm(settings(transport), NOW);
    expect(read.fields ?? read.recent ?? read.window).toBeUndefined();
    for (const part of ["fields", "recent", "window"] as const)
      expect(read.reasons[part]).toMatch(/cannot read the Lead object/);
    expect(read.reasons.recent).toMatch(/Read on Leads/);
    expect(transport.seen.at(-1)?.message.params?.name).toBe("getObjectSchema");
  });

  it("the quota is nearly used: the run stops at once, says so, and makes no further request", async () => {
    const transport = replayMcp("tideline-quota-near");
    const read = await readCrm(settings(transport), NOW);
    expect(read.recent ?? read.window ?? read.fields).toBeUndefined();
    expect(read.reasons.recent).toMatch(
      /96% of the org's API allowance used \(14400 of 15000\).*stopped at 90%/,
    );
    expect(transport.seen).toHaveLength(1);
  });

  it("stops at the percentage asked for, not before", async () => {
    const source = (stopAtPercent: number) =>
      salesforceMcpSource({
        server: SALESFORCE_READ_ONLY_URL,
        transport: replayMcp("tideline-quota-near"),
        stopAtPercent,
      });
    await expect(source(97).describeFields()).rejects.toThrow(/did not answer/);
    await expect(source(96).describeFields()).rejects.toThrow(/96%/);
  });

  it("the allowance runs out during the sample: what was read stays, the rest says why", async () => {
    const transport = replayMcp("tideline-quota-exceeded");
    const read = await readCrm(settings(transport), NOW);
    expect(read.fields).toBeDefined();
    expect(read.recent).toBeUndefined();
    expect(read.reasons.recent).toMatch(/API request limit is used up/);
    expect(read.reasons.window).toMatch(/API request limit is used up/);
    expect(read.reasons.fields).toBeUndefined();
  });

  it("makes no more than the call limit, and says it stopped", async () => {
    const transport = replayMcp("tideline-leads");
    const source = salesforceMcpSource({
      server: SALESFORCE_READ_ONLY_URL,
      transport,
      maxCalls: 4,
    });
    await source.describeFields();
    expect(transport.seen).toHaveLength(4);
    const err = await source.countLeads(SINCE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrmUnavailableError);
    expect((err as CrmUnavailableError).kind).toBe("limit");
    expect(transport.seen).toHaveLength(4);
  });
});

describe("salesforce-mcp: edge cases in what the server sends", () => {
  const serving = (...tools: string[]): McpTransport => ({
    send: (_server, message) =>
      Promise.resolve({
        body:
          message.method === "tools/list"
            ? { jsonrpc: "2.0", id: message.id, result: { tools: tools.map((name) => ({ name })) } }
            : message.method === "initialize"
              ? { jsonrpc: "2.0", id: message.id, result: {} }
              : message.id === undefined
                ? undefined
                : {
                    jsonrpc: "2.0",
                    id: message.id,
                    result: { content: [{ type: "text", text: "{}" }] },
                  },
      }),
  });

  it("does not use a server that lacks the read tools", async () => {
    const source = salesforceMcpSource({
      server: SALESFORCE_READ_ONLY_URL,
      transport: serving("find"),
    });
    await expect(source.describeFields()).rejects.toThrow(
      /does not offer soqlQuery and getObjectSchema/,
    );
  });

  it("shows a tool name from the server only as plain characters", async () => {
    const hostile = "createRecord\u202E<script>alert(1)</script>";
    const source = salesforceMcpSource({
      server: SALESFORCE_READ_ONLY_URL,
      transport: serving("getObjectSchema", "soqlQuery", hostile),
    });
    const err = (await source.describeFields().catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain("<script>");
    expect(err.message).not.toContain("\u202E");
  });

  it("maps HTTP 401, 403 and 429 to reasons in plain words", async () => {
    const failing = (status: number): McpTransport => ({
      send: () => Promise.reject(new McpHttpError(status)),
    });
    const reason = async (status: number) =>
      (await salesforceMcpSource({ server: SALESFORCE_READ_ONLY_URL, transport: failing(status) })
        .describeFields()
        .catch((e: Error) => e)) as CrmUnavailableError;
    expect((await reason(401)).message).toMatch(/did not accept the access token/);
    expect((await reason(403)).message).toMatch(/refused the signed-in user access/);
    expect((await reason(429)).kind).toBe("quota");
    expect((await reason(500)).message).toMatch(/HTTP 500/);
  });

  it("treats a transport that fails, or a reply that is not JSON-RPC, as unreachable without echoing it", async () => {
    const boom: McpTransport = {
      send: () => Promise.reject(new Error("socket hang up Bearer sk-secret")),
    };
    const junk: McpTransport = {
      send: () => Promise.resolve({ body: "<html>Bearer sk-secret</html>" }),
    };
    for (const transport of [boom, junk]) {
      const err = (await salesforceMcpSource({ server: SALESFORCE_READ_ONLY_URL, transport })
        .describeFields()
        .catch((e: Error) => e)) as CrmUnavailableError;
      expect(err.kind).toBe("unreachable");
      expect(err.message).not.toContain("sk-secret");
    }
  });

  it("never repeats a Salesforce error's own text, only what it recognised", async () => {
    const transport: McpTransport = {
      send: (_s, m) =>
        Promise.resolve({
          body: {
            jsonrpc: "2.0",
            id: m.id,
            error: {
              code: -32000,
              message: `Row for Rowan Ellery <${["rowan", "example.invalid"].join("@")}> locked`,
            },
          },
        }),
    };
    const err = (await salesforceMcpSource({ server: SALESFORCE_READ_ONLY_URL, transport })
      .describeFields()
      .catch((e: Error) => e)) as Error;
    expect(err.message).not.toContain("Rowan");
    expect(err.message).not.toContain("@");
  });

  it("keeps only valid record ids, so a field in the wrong place cannot become an id", async () => {
    const transport: McpTransport = {
      send: (_s, m) => {
        if (m.id === undefined) return Promise.resolve({});
        const result =
          m.method === "tools/list"
            ? { tools: ["soqlQuery", "getObjectSchema"].map((name) => ({ name })) }
            : m.method === "tools/call"
              ? {
                  structuredContent: {
                    records: [
                      { Id: "Rowan Ellery", LeadSource: null },
                      { Id: "00Q5e00000Tx001", LeadSource: null },
                      { Id: 7, LeadSource: null },
                    ],
                  },
                }
              : {};
        return Promise.resolve({ body: { jsonrpc: "2.0", id: m.id, result } });
      },
    };
    const sample = await salesforceMcpSource({
      server: SALESFORCE_READ_ONLY_URL,
      transport,
    }).sampleLeads(SINCE, ["LeadSource"]);
    expect(sample.leads).toEqual([{ id: "00Q5e00000Tx001", blank: ["LeadSource"] }]);
  });

  it("marks a sample that stopped at its limit as truncated", async () => {
    const transport = replayMcp("tideline-leads");
    const source = salesforceMcpSource({ server: SALESFORCE_READ_ONLY_URL, transport });
    const sample = await source.sampleLeads(SINCE, ["LeadSource"], 40);
    expect(sample.truncated).toBe(true);
  });

  it("the recordings are invented: no recorded lead carries a name, email or key", () => {
    for (const name of ["tideline-leads", "tideline-custom-field", "tideline-quiet"]) {
      const text = JSON.stringify(readMcpRecording(name));
      expect(text).not.toMatch(/@|Bearer|sk_|"(?:FirstName|LastName|Email|Phone|Name)":/);
    }
  });
});
