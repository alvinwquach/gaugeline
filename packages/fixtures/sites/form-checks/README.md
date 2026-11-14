# form-checks

An invented physiotherapy clinic (Harbour Physio) for the form and CRM tracking checks (G25a). Nothing
here is a real business, account or form.

- The Pardot tracking code in the head loads `pd.js` from a window load handler, and the Pardot form is
  an iframe: `crm-late-tracking`. The code is on the page, so `crm-no-tracking` does not fire for it.
- A HubSpot newsletter form with no HubSpot tracking code on the page: `crm-no-tracking`.
- A Salesforce Web-to-Lead form and the HubSpot form with no `utm_*`, `gclid` or lead source field:
  `crm-no-campaign-fields`. The Pardot iframe is another document, so it is could-not-check.
- Pardot, Web-to-Lead and HubSpot on one page: `forms-many-providers`.
- "Talk to a physio" opens an email: `mailto-cta`.
- `crm-insecure` needs an https page, and the fixture servers are plain http. It is exercised in
  process (checks/__tests__/forms.test.ts) and in the docs test.
