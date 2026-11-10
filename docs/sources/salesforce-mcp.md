# Salesforce leads through its own MCP server

Available from version 0.2.0.

Find out whether the leads your client's forms send actually arrive in Salesforce with their source, by reading the CRM through the read-only server Salesforce hosts, with a user who can only look.

A form check can prove a form was on the page and carried the campaign. Only the CRM can prove the lead arrived with it. A coach, a clinic or a studio that runs Salesforce usually has no one looking at the Lead list for blanks, so a form that quietly stopped passing the source along can go unnoticed for months. This page is for the freelancer who built the site and has been given a login to check it. Gaugeline reads. It never creates, changes or deletes a record.

::: warning This version cannot connect on its own yet
The three checks, the read-only guard and the recorded-response tests are built and shipped. The one piece that is not is the network connection to Salesforce: talking to an MCP server means sending JSON-RPC messages with `POST`, and Gaugeline's rule (ADR-0001, ADR-0005) is that only the fetcher, which refuses `POST`, and the notification sender may make a request. Adding a third place needs its own reviewed decision, and that decision is the owner's. Until it is made, a run with `gaugeline.crm.json` says the CRM was not checked, with that reason, under "could not check". It never passes, and nothing is sent to Salesforce.
:::

## What it checks

All three run only when `gaugeline.crm.json` is in the folder you run Gaugeline from. They are in the Leads area.

| Check                             | Catches                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| [`crm-lead-source`](/docs/checks) | Many of the leads created since the last run have an empty source or campaign field |
| [`crm-field-names`](/docs/checks) | A Web-to-Lead form sends field names that Salesforce's Lead object does not have    |
| [`crm-went-quiet`](/docs/checks)  | Leads stopped for several days while the form is still on the page                  |

- **`crm-lead-source`** looks at the newest 200 leads created since the last run (the run before it, with `--since last`), or the last 7 days when there is no earlier run. It flags the window when at least 2 leads, and at least a tenth of them, have an empty field. Those two numbers are proposed, not Salesforce's. The field is `LeadSource` unless you name others in `sourceFields`: a custom `Campaign_Source__c`, for example.
- **`crm-field-names`** compares every field name in each Web-to-Lead form on the page (hidden or visible) with the fields and labels of Lead. Web-to-Lead's own names are matched to their fields (`first_name` is `FirstName`, `zip` is `PostalCode`, `lead_source` is `LeadSource`). Routing, anti-spam and `utm_*` names are skipped. A custom field sent by its id (`00N5e...`) cannot be compared with a name, so it is counted and left alone. Only Web-to-Lead forms in the HTML are read; a form in an iframe is another document and is reported under could not check.
- **`crm-went-quiet`** needs at least 5 leads in the last 14 days and then none for `quietDays` whole days (3 by default), on a page that has a form or embed from a provider Gaugeline [recognises](/docs/forms-and-crm). With fewer leads than that, a quiet spell proves nothing, and it says so.

## Set it up in Salesforce

Salesforce hosts several MCP servers. Gaugeline uses one, the read-only objects server (`sobject-reads`), and refuses to start with any other, including the ones that can write.

1. In Setup, open **External Client App Manager** and create an **External Client App**. Salesforce's hosted MCP servers do not work with the older Connected Apps.
2. Turn on OAuth, give it the scopes Salesforce's guide asks for hosted MCP servers (`mcp_api`, and `refresh_token` if you want the token to renew), and keep the callback to a page you control.
3. Under **MCP servers** (Salesforce's hosted server list), activate **only** the read-only objects server. Leave the mutation and combined servers off.
4. Wait for the app to become active. Salesforce says this can take up to 30 minutes.
5. Install it for the people who need it and sign in as the user Gaugeline should read as: the OAuth sign-in gives that user's access token.

A **sandbox** has the same server under `/platform/mcp/v1/sandbox/platform/sobject-reads`. Put it in `server` in the file below to use it.

### What the signed-in user must be allowed to read

Gaugeline reads as that user, so it can see exactly what they can see and nothing else:

- **Read** on the **Lead** object.
- **Read** on the Lead fields you name in `sourceFields` (field-level security): `LeadSource` and any custom campaign field.
- The right to use the API and the External Client App.

Give it **no** create, edit or delete permission. A dedicated user with a read-only profile or permission set is the narrowest option, and the one to prefer over a person's own login. Names, emails and phone numbers do not need to be readable for any of this to work, and Gaugeline never asks for them; the sample asks for the record id and the source fields only.

### Where the token goes

The access token is an environment variable, `SALESFORCE_MCP_ACCESS_TOKEN`, read by the connection and by nothing else. It is not a flag, not in `gaugeline.crm.json`, not in a fixture and never in output. Gaugeline does not run the sign-in or renew the token for you; when a run says Salesforce did not accept the token, get a new one.

## `gaugeline.crm.json`

```json title=gaugeline.crm.json
{
  "salesforce": {
    "sourceFields": ["LeadSource", "Campaign_Source__c"],
    "windowDays": 7,
    "quietDays": 3
  }
}
```

| Key            | Default                                                             | What it does                                                                                        |
| -------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `server`       | `https://api.salesforce.com/platform/mcp/v1/platform/sobject-reads` | The read-only server. Any other address is refused when the file is read                            |
| `sourceFields` | `["LeadSource"]`                                                    | Up to four fields that say where a lead came from. A field that holds a person's details is refused |
| `windowDays`   | `7`                                                                 | How far back to look when there is no earlier run (1 to 30)                                         |
| `quietDays`    | `3`                                                                 | Whole days without a lead that count as quiet (2 to 14)                                             |

An address for a server that can write is not "used carefully": the file is not accepted and the run stops with exit code 2 before anything is requested.

## What is asked

At most **8 requests** in a run, however many checks use them, because each one counts against the customer's Salesforce API allowance:

1. The MCP handshake: `initialize`, `notifications/initialized` and `tools/list` (3). If the server lists any tool that can change data, the run stops there.
2. `getObjectSchema` for Lead: the field names and labels (1).
3. `soqlQuery`: the newest 200 leads since the window starts, with the record id and the source fields (1).
4. `soqlQuery`: the count of leads in the last 14 days and when the newest was created (1).

Only the two read tools `soqlQuery` and `getObjectSchema` are ever called. Each query is a single `SELECT` that Gaugeline builds from a fixed template and field names it has checked; no text from a page, a lead or the server ever becomes part of one.

If Salesforce reports that 90% of the org's API allowance is used, the run stops there and the checks say so. If it answers `REQUEST_LIMIT_EXCEEDED`, the same.

### What is kept

Counts, field names and record ids. For each lead: its id, and which of the named fields are empty. A lead's name, email, phone, company, address, notes and the values of the source fields are dropped before anything is looked at, even if the server sends them. Only an id that is a Salesforce record id (15 or 18 letters and digits) is shown.

## Example: a coach whose leads lost their source

Tideline Coaching (invented) has a Web-to-Lead form for free intro sessions. Its Salesforce admin added `promo_code` and `preferred_time` to the form last spring, but Lead has no field by either name (the custom field is called `Preferred_Session__c`), and a later change to the form stopped passing the lead source along. Gaugeline read Salesforce through recorded responses (`packages/fixtures/salesforce-mcp/tideline-leads.json`, written by hand, no real account) on 10 November 2026:

```text title=Tideline findings
crm-field-names: A Web-to-Lead form sends promo_code, preferred_time, which Lead has no field for (5 other fields matched; 1 custom field was sent by id and not compared)
crm-lead-source: 12 of 40 leads created since 2026-11-03 have an empty LeadSource. Example record ids: 00Q5e00000Tx002, 00Q5e00000Tx003, 00Q5e00000Tx007, 00Q5e00000Tx009, 00Q5e00000Tx012
```

Twelve of the week's forty leads arrived with no source, and the five ids are where to start looking in Salesforce. No name or email appears: Gaugeline never held one. The test `packages/core/src/sources/__tests__/crm-docs.test.ts` runs the recording through the checks and asserts these lines.

## When it cannot check

A run never passes a check it could not run. These are the reasons it gives:

| Reason                                         | What to do                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| No connection in this build                    | Waiting for the owner's decision described at the top of this page          |
| The signed-in user cannot read the Lead object | Give them Read on Leads (and on the source fields)                          |
| Salesforce did not accept the access token     | Get a new token for the External Client App                                 |
| The read-only server is not the one configured | Fix `server` in `gaugeline.crm.json`; a write-capable address is never used |
| The server lists a tool that can change data   | Check which MCP server the External Client App has activated                |
| The API allowance is nearly used               | Run later; each run uses at most 8 requests                                 |
| Lead has no field called `X`                   | Check `sourceFields` against the field names in Salesforce                  |
| No recognised form on the page                 | Run the check on the page that has the form                                 |

## What is not verified

Salesforce's own pages for the hosted servers were not reachable when this was written. The server addresses, the tool names (`soqlQuery`, `getObjectSchema`), the `query` argument and the setup steps follow third-party guides and Salesforce's published summary of the servers, and are **uncited**. The name of the schema tool's argument (`objectName`), the shape of both answers and the way the API allowance is reported (the `Sforce-Limit-Info` header) are assumed from Salesforce's REST API. Check each against [Salesforce's hosted MCP documentation](https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide) before relying on them, and re-record the responses once against a developer org.
