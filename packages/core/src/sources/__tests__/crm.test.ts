import { describe, expect, it } from "vitest";
import {
  crmConfigSchema,
  isBlank,
  isIdentifier,
  isPersonalField,
  leadWindowStart,
  quietLookbackDays,
  splitFields,
  stripPersonal,
} from "../crm.js";

describe("crm: personal fields never leave the source", () => {
  it("names the standard and custom fields that hold a person's details", () => {
    for (const name of [
      "Name",
      "FirstName",
      "LastName",
      "Email",
      "Phone",
      "MobilePhone",
      "Company",
      "Street",
      "PostalCode",
      "Description",
      "Website",
      "email",
      "Personal_Email__c",
      "Home_Phone__c",
      "Date_of_Birth__c",
    ])
      expect(isPersonalField(name), name).toBe(true);
  });

  it("lets the lead source and campaign fields through, custom ones included", () => {
    for (const name of [
      "LeadSource",
      "Campaign_Source__c",
      "Campaign_Name__c",
      "UTM_Campaign__c",
      "Status",
      "CreatedDate",
      "Id",
    ])
      expect(isPersonalField(name), name).toBe(false);
  });

  it("splits a request into the fields that may be asked for and the ones refused", () => {
    expect(
      splitFields(["LeadSource", "Email", "Campaign_Source__c", "Name", "LeadSource", " "]),
    ).toEqual({ allowed: ["LeadSource", "Campaign_Source__c"], refused: ["Email", "Name"] });
  });

  it("refuses anything that is not a plain field name, so no text reaches a query", () => {
    const { allowed, refused } = splitFields([
      "LeadSource FROM Lead; DELETE FROM Lead",
      "LeadSource, Email",
      "Lead.Source",
      "1Field",
      "A".repeat(80),
      "LeadSource)",
    ]);
    expect(allowed).toEqual([]);
    expect(refused).toHaveLength(6);
    expect(isIdentifier("Campaign_Source__c")).toBe(true);
  });

  it("strips personal fields and the attributes envelope from a record, whatever the case", () => {
    const record = {
      attributes: { type: "Lead", url: "/services/data/v62.0/sobjects/Lead/00Q5e00000Tx001" },
      Id: "00Q5e00000Tx001",
      LeadSource: "Web",
      FirstName: "Rowan",
      LASTNAME: "Ellery",
      email: ["rowan", "example.invalid"].join("@"),
      Description: "knee rehab",
      Campaign_Source__c: null,
    };
    expect(stripPersonal(record)).toEqual({
      Id: "00Q5e00000Tx001",
      LeadSource: "Web",
      Campaign_Source__c: null,
    });
  });

  it("calls a field empty when it is missing, null or blank, and not when it is zero or false", () => {
    expect([undefined, null, "", "   "].map(isBlank)).toEqual([true, true, true, true]);
    expect([0, false, "Web", "0"].map(isBlank)).toEqual([false, false, false, false]);
  });
});

describe("gaugeline.crm.json", () => {
  const ok = (v: unknown) => crmConfigSchema.safeParse(v);

  it("defaults to the read-only server, the standard lead source, 7 days and 3 quiet days", () => {
    const r = ok({ salesforce: {} });
    expect(r.success && r.data.salesforce).toEqual({
      server: "https://api.salesforce.com/platform/mcp/v1/platform/sobject-reads",
      sourceFields: ["LeadSource"],
      windowDays: 7,
      quietDays: 3,
    });
  });

  it("accepts the sandbox read-only server and a custom campaign field", () => {
    expect(
      ok({
        salesforce: {
          server: "https://api.salesforce.com/platform/mcp/v1/sandbox/platform/sobject-reads",
          sourceFields: ["LeadSource", "Campaign_Source__c"],
          windowDays: 14,
          quietDays: 5,
        },
      }).success,
    ).toBe(true);
  });

  it("refuses a server that can write, and says why", () => {
    const r = ok({
      salesforce: { server: "https://api.salesforce.com/platform/mcp/v1/platform/sobject-all" },
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("read-only objects server");
  });

  it("refuses a token in the file, a personal source field and unknown keys", () => {
    expect(ok({ salesforce: { accessToken: "nope" } }).success).toBe(false);
    expect(ok({ salesforce: { sourceFields: ["Email"] } }).success).toBe(false);
    expect(ok({ salesforce: { sourceFields: ["LeadSource; DROP"] } }).success).toBe(false);
    expect(ok({ salesforce: { sourceFields: [] } }).success).toBe(false);
    expect(ok({ hubspot: {} }).success).toBe(false);
    expect(ok({}).success).toBe(false);
  });

  it("keeps the windows inside their limits", () => {
    expect(ok({ salesforce: { windowDays: 0 } }).success).toBe(false);
    expect(ok({ salesforce: { windowDays: 31 } }).success).toBe(false);
    expect(ok({ salesforce: { quietDays: 1 } }).success).toBe(false);
    expect(ok({ salesforce: { quietDays: 15 } }).success).toBe(false);
  });
});

describe("crm: the window leads are counted in", () => {
  const now = new Date("2026-11-10T18:00:00Z");

  it("starts at the last run when there is one", () => {
    expect(leadWindowStart(now, 7, "2026-11-08T09:30:00.000Z").toISOString()).toBe(
      "2026-11-08T09:30:00.000Z",
    );
  });

  it("falls back to windowDays before now with no previous run, or one in the future or unreadable", () => {
    const week = "2026-11-03T18:00:00.000Z";
    expect(leadWindowStart(now, 7).toISOString()).toBe(week);
    expect(leadWindowStart(now, 7, "2026-12-01T00:00:00Z").toISOString()).toBe(week);
    expect(leadWindowStart(now, 7, "not a date").toISOString()).toBe(week);
  });

  it("never looks back more than 30 days, however old the last run is", () => {
    expect(leadWindowStart(now, 7, "2026-06-01T00:00:00Z").toISOString()).toBe(
      "2026-10-11T18:00:00.000Z",
    );
  });

  it("looks back at least 14 days for the quiet check, and four times a long quiet spell", () => {
    expect(quietLookbackDays(3)).toBe(14);
    expect(quietLookbackDays(14)).toBe(56);
  });
});
