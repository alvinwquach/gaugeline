# Forms and CRM tracking

Whether a lead can reach your CRM knowing where it came from.

Gaugeline recognizes Pardot (Marketing Cloud Account Engagement), Salesforce Web-to-Lead, HubSpot, Formstack, Marketo and Typeform on a page, and checks four things without any login.

<!-- diagram: leads (drawn on the landing page; not reproduced here) -->

- **If you own the site:** If this is wrong, you still get leads: you just can't tell which advert, email or search brought them.
- **If you run marketing:** This is the attribution gap that makes a working campaign look dead in reporting.
- **If you edit content:** If a form on a page you edit is flagged, send it to whoever set up the form.
- **If you build the site:** Checked from the rendered page: the tracking script, its load order, the form action, and the presence of hidden campaign fields.

## The four checks

| Check                               | Why                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| A form with no tracking on the page | The CRM can't connect the lead to the campaign that brought them.                    |
| Tracking that loads after the form  | Salesforce documents that this loses first-touch and UTM data.                       |
| An insecure form                    | Part of the form or its tracking loads over plain http.                              |
| No campaign fields                  | A form posting to a CRM with no `utm_*` or `gclid` inputs; every lead arrives blank. |

::: info
Reading Pardot or Salesforce directly, to count how many recent leads arrived with a blank source, needs a read-only login and is on the roadmap.
:::
